/// platform.rs — OS-specific process and environment operations for Avio.
///
/// Mirrors the design of `backend/platform_env.py`: a trait defines the
/// interface every OS must implement, and concrete structs provide the
/// platform-specific behaviour.  `get_platform()` returns the right one at
/// runtime.  Adding support for a new OS means adding a new struct that
/// implements `PlatformOps` — nothing else in `main.rs` changes.
///
/// Current operations:
///   • `spawn_flags`      — apply OS-specific flags when spawning the backend
///                          (e.g. create a new process group on Unix so the
///                          whole tree can be killed together)
///   • `kill_process`     — kill a child process and all of its descendants
///   • `graceful_shutdown_url` — (informational) where to POST for a soft stop

use std::process::{Child, Command};

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

pub trait PlatformOps: Send + Sync {
    /// Apply OS-specific pre-spawn configuration to `cmd`.
    /// Called in `start_backend` just before `.spawn()`.
    fn apply_spawn_flags(&self, cmd: &mut Command);

    /// Called right after a successful `.spawn()`. Default is a no-op;
    /// Windows uses it to assign the child to its Job Object.
    fn on_spawned(&self, _child: &Child) {}

    /// Kill `child` and every process it has spawned.
    /// On Unix this kills the whole process group; on Windows it uses
    /// `TerminateJobObject` so child processes cannot outlive the job.
    /// Returns `Ok(())` if all processes were signalled (not necessarily
    /// that they have exited yet — call `child.wait()` afterwards).
    fn kill_process_tree(&self, child: &mut Child) -> std::io::Result<()>;
}

// ---------------------------------------------------------------------------
// macOS / Linux  (any Unix)
// ---------------------------------------------------------------------------

/// Unix implementation.
///
/// • Spawn: calls `setsid()` in `pre_exec` so the backend becomes the leader
///   of a new process group.  All uvicorn worker processes it forks will
///   inherit that group ID.
///
/// • Kill: sends `SIGKILL` to the entire process group via `killpg`, ensuring
///   no orphaned workers survive.
#[cfg(unix)]
pub struct UnixPlatform;

#[cfg(unix)]
impl PlatformOps for UnixPlatform {
    fn apply_spawn_flags(&self, cmd: &mut Command) {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid() is async-signal-safe and has no Rust invariants.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    fn kill_process_tree(&self, child: &mut Child) -> std::io::Result<()> {
        let pgid = child.id() as libc::pid_t;
        // SAFETY: pgid is a valid pid from a process we own.
        let rc = unsafe { libc::killpg(pgid, libc::SIGKILL) };
        if rc == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// Windows implementation.
///
/// • Spawn: assigns the backend to a Windows Job Object so child processes
///   cannot outlive the job (handled at OS level, no pre_exec needed).
///   For simplicity we currently use the default flags; a full Job Object
///   implementation can be added here when the Windows build is underway.
///
/// • Kill: calls `child.kill()` which issues `TerminateProcess`.  For the
///   Windows build, this should be upgraded to `TerminateJobObject` so all
///   worker processes in the job are terminated atomically.
#[cfg(windows)]
pub struct WindowsPlatform;

#[cfg(windows)]
mod job {
    use std::io;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(pub HANDLE);

    // SAFETY: a Job Object handle is just a kernel handle; the Win32 job APIs
    // are safe to call from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    /// Process-wide job with KILL_ON_JOB_CLOSE. The handle is never closed
    /// explicitly: when Avio exits for any reason the OS closes it and
    /// kills every process still in the job.
    pub fn get() -> io::Result<&'static Job> {
        JOB.get_or_init(create)
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "failed to create Job Object"))
    }

    fn create() -> Option<Job> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Job(handle))
        }
    }
}

#[cfg(windows)]
impl PlatformOps for WindowsPlatform {
    fn apply_spawn_flags(&self, cmd: &mut Command) {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    fn on_spawned(&self, child: &Child) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        match job::get() {
            Ok(job) => {
                // SAFETY: both handles are valid for the duration of the call.
                let ok = unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as _) };
                if ok == 0 {
                    eprintln!(
                        "[backend] AssignProcessToJobObject failed: {}",
                        std::io::Error::last_os_error()
                    );
                }
            }
            Err(e) => eprintln!("[backend] {e}"),
        }
    }

    fn kill_process_tree(&self, child: &mut Child) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if let Ok(job) = job::get() {
            // SAFETY: job.0 is a valid job handle.
            if unsafe { TerminateJobObject(job.0, 1) } != 0 {
                return Ok(());
            }
        }
        child.kill()
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::process::Stdio;
    use std::time::Duration;

    fn running(name: &str) -> bool {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {name}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(name)
    }

    /// cmd.exe spawns ping.exe as a grandchild; killing the tree must take
    /// both down, which `child.kill()` alone would not.
    #[test]
    fn kill_process_tree_kills_grandchildren() {
        let plat = WindowsPlatform;
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "ping -n 60 127.0.0.1 >NUL"])
            .stdout(Stdio::null());
        plat.apply_spawn_flags(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        plat.on_spawned(&child);

        std::thread::sleep(Duration::from_millis(1500));
        assert!(running("PING.EXE"), "grandchild should be running");

        plat.kill_process_tree(&mut child).unwrap();
        let _ = child.wait();
        std::thread::sleep(Duration::from_millis(500));
        assert!(!running("PING.EXE"), "grandchild survived kill_process_tree");
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/// Return the platform implementation for the current OS.
pub fn get_platform() -> Box<dyn PlatformOps> {
    #[cfg(unix)]
    { Box::new(UnixPlatform) }

    #[cfg(windows)]
    { Box::new(WindowsPlatform) }

    #[cfg(not(any(unix, windows)))]
    compile_error!("Unsupported platform — add a PlatformOps impl for this OS");
}
