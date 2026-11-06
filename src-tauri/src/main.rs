// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, State};

struct BackendProcess(Mutex<Option<Child>>);
struct BackendPort(u16);

fn find_free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

fn project_root() -> std::path::PathBuf {
    // In dev, the binary runs from src-tauri/target/debug/ — walk up to find
    // the directory that contains a "backend" folder.
    let exe = std::env::current_exe().unwrap_or_default();
    let mut dir = exe.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    for _ in 0..6 {
        if dir.join("backend").exists() {
            return dir;
        }
        if let Some(parent) = dir.parent() {
            dir = parent.to_path_buf();
        } else {
            break;
        }
    }
    // Fallback: current working directory
    std::env::current_dir().unwrap_or_default()
}

fn start_backend(port: u16, app_handle: Option<&tauri::AppHandle>) -> Option<Child> {
    // 1. Try bundled binary (production) via Tauri resource resolver
    let bundled = app_handle.and_then(|h| {
        h.path().resource_dir().ok().map(|d| d.join("sf_backend"))
    });

    // 2. Fall back to dev: venv python running main.py
    let root = project_root();
    let venv_python = root.join("backend").join(".venv").join("bin").join("python");

    if let Some(bin) = bundled.filter(|p| p.exists()) {
        eprintln!("[backend] starting bundled binary: {}", bin.display());
        Command::new(&bin)
            .env("SF_BACKEND_PORT", port.to_string())
            .spawn()
            .ok()
    } else if venv_python.exists() {
        let script = root.join("backend").join("main.py");
        eprintln!("[backend] starting dev server: {} {}", venv_python.display(), script.display());
        Command::new(&venv_python)
            .arg(&script)
            .env("SF_BACKEND_PORT", port.to_string())
            .spawn()
            .ok()
    } else {
        eprintln!("[backend] ERROR: could not find sf_backend binary or venv python");
        None
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Open a file with the OS default application
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let cmd = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(cmd)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open '{}': {}", path, e))?;
    Ok(())
}

#[tauri::command]
fn get_backend_port(state: State<'_, BackendPort>) -> u16 {
    state.0
}

/// Proxy GET requests from the WebView through Rust (no CSP restrictions)
#[tauri::command]
async fn api_get(
    path: String,
    state: tauri::State<'_, BackendPort>,
) -> Result<serde_json::Value, String> {
    let port = state.0;
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {:?}", status, body));
    }
    Ok(body)
}

/// Proxy POST requests from the WebView through Rust
#[tauri::command]
async fn api_post(
    path: String,
    body: serde_json::Value,
    state: tauri::State<'_, BackendPort>,
) -> Result<serde_json::Value, String> {
    let port = state.0;
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {:?}", status, result));
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    // In dev, backend is already running on fixed port 7891 via concurrently
    let port: u16 = if cfg!(debug_assertions) {
        std::env::var("SF_BACKEND_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(7891)
    } else {
        find_free_port()
    };

    tauri::Builder::default()
        .manage(BackendPort(port))
        .manage(BackendProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            api_get,
            api_post,
            open_file
        ])
        .setup(move |app| {
            // In production, spawn the bundled backend binary
            if !cfg!(debug_assertions) {
                if let Some(child) = start_backend(port, Some(app.handle())) {
                    if let Ok(mut guard) = app.state::<BackendProcess>().0.lock() {
                        *guard = Some(child);
                    }
                }
            }
            let window = app.get_webview_window("main").unwrap();
            let _ = window.eval(&format!("window.__SF_BACKEND_PORT__ = {}", port));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<BackendProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
