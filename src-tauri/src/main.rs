// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

#[cfg(windows)]
const BACKEND_BIN: &str = "sf_backend.exe";
#[cfg(not(windows))]
const BACKEND_BIN: &str = "sf_backend";

#[cfg(windows)]
const VENV_PYTHON: &str = "Scripts\\python.exe";
#[cfg(not(windows))]
const VENV_PYTHON: &str = "bin/python";

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
        h.path().resource_dir().ok().map(|d| d.join(BACKEND_BIN))
    });

    // 2. Fall back to dev: venv python running main.py
    let root = project_root();
    let venv_python = root.join("backend").join(".venv").join(VENV_PYTHON);

    let plat = platform::get_platform();

    if let Some(bin) = bundled.filter(|p| p.is_file()) {
        eprintln!("[backend] starting bundled binary: {}", bin.display());
        let mut cmd = Command::new(&bin);
        cmd.env("SF_BACKEND_PORT", port.to_string());
        plat.apply_spawn_flags(&mut cmd);
        let child = cmd.spawn().ok();
        if let Some(c) = &child { plat.on_spawned(c); }
        child
    } else if venv_python.exists() {
        let script = root.join("backend").join("main.py");
        eprintln!("[backend] starting dev server: {} {}", venv_python.display(), script.display());
        let mut cmd = Command::new(&venv_python);
        cmd.arg(&script).env("SF_BACKEND_PORT", port.to_string());
        plat.apply_spawn_flags(&mut cmd);
        let child = cmd.spawn().ok();
        if let Some(c) = &child { plat.on_spawned(c); }
        child
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

/// Turn a failed backend response into a readable error string.
/// FastAPI errors look like {"detail": "..."}; session-expired errors carry
/// code "session_expired" and are passed through as just the message so the
/// UI can show "run `sf org login web --alias X`" without an HTTP prefix.
fn http_error(status: reqwest::StatusCode, body: &serde_json::Value) -> String {
    let detail = match body.get("detail") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => body.to_string(),
    };
    if body.get("code").and_then(|c| c.as_str()) == Some("session_expired") {
        detail
    } else {
        format!("HTTP {}: {}", status, detail)
    }
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
        return Err(http_error(status, &body));
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
        return Err(http_error(status, &result));
    }
    Ok(result)
}

/// Build the macOS app menu, replacing the native "About Vendavis" item with
/// one that emits our custom event so the in-app modal opens instead.
#[cfg(target_os = "macos")]
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // "Vendavis" application menu (left-most on macOS menu bar)
    let about_item = MenuItem::with_id(app, "about", "About Vendavis", true, None::<&str>)?;
    let separator  = PredefinedMenuItem::separator(app)?;
    let hide       = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all   = PredefinedMenuItem::show_all(app, None)?;
    let quit       = PredefinedMenuItem::quit(app, None)?;

    let app_menu = Submenu::with_items(
        app,
        "Vendavis",
        true,
        &[
            &about_item,
            &separator,
            &hide,
            &hide_others,
            &show_all,
            &separator,
            &quit,
        ],
    )?;

    Menu::with_items(app, &[&app_menu])
}

/// Called by the frontend when the user confirms they want to quit.
/// Tells the backend to shut down gracefully, then kills the process group
/// and exits the application.
#[tauri::command]
async fn confirm_close(
    app: tauri::AppHandle,
    backend: tauri::State<'_, BackendProcess>,
    port: tauri::State<'_, BackendPort>,
) -> Result<(), ()> {
    let backend_port = port.0;

    // 1. Ask the backend to shut down gracefully via HTTP (gives uvicorn time
    //    to finish any in-flight request and close its own workers).
    let shutdown_url = format!("http://127.0.0.1:{}/api/shutdown", backend_port);
    let _ = reqwest::Client::new()
        .post(&shutdown_url)
        .timeout(std::time::Duration::from_millis(800))
        .send()
        .await;

    // Brief pause so uvicorn can handle the SIGTERM
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    // 2. Kill the tracked child process and all its descendants.
    //    Delegates to the OS-specific PlatformOps implementation so the
    //    kill strategy is correct for each platform (process group on Unix,
    //    Job Object on Windows).
    let plat = platform::get_platform();
    if let Ok(mut guard) = backend.0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = plat.kill_process_tree(&mut child);
            let _ = child.wait();
        }
    }

    // 3. Hard exit — ensures no stray threads keep the process alive.
    //    drop app handle first to avoid any cleanup that could block.
    drop(app);
    std::process::exit(0);
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

    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .manage(BackendPort(port))
        .manage(BackendProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            api_get,
            api_post,
            open_file,
            confirm_close
        ]);

    // macOS: replace the native "About Vendavis" menu item with one that
    // opens our custom in-app About modal instead of the system dialog.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .menu(|app| build_app_menu(app))
            .on_menu_event(|app, event| {
                if event.id().0 == "about" {
                    // Emit to the main window so the frontend can open its modal
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("app:open-about", ());
                    }
                }
            });
    }

    builder
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
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the default close so we can show a confirm dialog in the UI
                api.prevent_close();
                // Tell the frontend to show the "Stop background processes?" modal
                let _ = window.emit("app:close-requested", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
