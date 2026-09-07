use std::ffi::OsStr;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;

use tokio::process::{Child, Command};

/// Prepare process-wide environment before the WebView and its child processes
/// start. Every child WebKit process inherits this environment, so it must be
/// set before `tauri::Builder` runs.
///
/// - `WEBKIT_DISABLE_DMABUF_RENDERER` / `WEBKIT_DISABLE_COMPOSITING_MODE`:
///   WebKitGTK's accelerated renderer assumes a real GPU. Under virtual-machine
///   display drivers (VMware, VirtualBox, virgl) and software GL it crashes the
///   web process, which the user sees as a white window or an editor that never
///   reacts to imports. The portable renderer is slower but actually starts.
/// - `GIO_MODULE_DIR`: an AppImage built on the oldest supported distribution
///   ships an older GLib than newer hosts. The host's GIO modules under
///   `/usr/lib` then fail to load with `undefined symbol` errors and can take
///   the web process down with them, so an AppImage run uses only the GIO
///   modules it bundled.
///
/// Each value is only set when the user has not already chosen one. Because
/// WebKitGTK treats any value of its `WEBKIT_DISABLE_*` variables (even `0`) as
/// "disable", two opt-outs are read from the launch environment:
/// - `TUCK_WEBKIT_ACCELERATED=1` keeps the full accelerated renderer.
/// - `TUCK_WEBKIT_COMPOSITING=1` still disables the DMABUF renderer (the common
///   virtual-machine crash) but leaves accelerated compositing on, which some
///   WebKitGTK builds need to draw `<video>` frames.
pub fn prepare_runtime_environment() {
    let accelerated = env_flag_is_set("TUCK_WEBKIT_ACCELERATED");
    let keep_compositing = env_flag_is_set("TUCK_WEBKIT_COMPOSITING");
    for (key, value) in webkit_env_defaults(accelerated, keep_compositing) {
        set_default_env(key, value);
    }
    if let Some(modules) = bundled_gio_module_dir(std::env::var_os("APPDIR").map(PathBuf::from)) {
        set_default_env("GIO_MODULE_DIR", modules);
    }
}

fn webkit_env_defaults(
    accelerated: bool,
    keep_compositing: bool,
) -> Vec<(&'static str, &'static str)> {
    if accelerated {
        return Vec::new();
    }
    let mut defaults = vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")];
    if !keep_compositing {
        defaults.push(("WEBKIT_DISABLE_COMPOSITING_MODE", "1"));
    }
    defaults
}

/// Resolve the AppImage's own GIO module directory, or `None` when not running
/// from an AppImage or when the bundle has no such directory.
fn bundled_gio_module_dir(appdir: Option<PathBuf>) -> Option<PathBuf> {
    let modules = appdir?.join("usr/lib/x86_64-linux-gnu/gio/modules");
    modules.is_dir().then_some(modules)
}

fn set_default_env(key: &str, value: impl AsRef<OsStr>) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

/// A launch-environment flag counts as set for any value except empty or `0`.
fn env_flag_is_set(key: &str) -> bool {
    match std::env::var(key) {
        Ok(value) => !value.is_empty() && value != "0",
        Err(_) => false,
    }
}

pub struct ProcessTreeGuard {
    process_group: libc::pid_t,
    armed: bool,
}

impl ProcessTreeGuard {
    pub fn attach(child: &Child) -> io::Result<Self> {
        let process_group = child.id().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "child process ID is unavailable")
        })? as libc::pid_t;
        Ok(Self {
            process_group,
            armed: true,
        })
    }

    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = kill_process_group(self.process_group);
            reap_process(self.process_group);
        }
    }
}

pub fn configure_child_process(command: &mut Command) {
    // the sidecar is the leader so one signal reaches its FFmpeg descendants
    command.as_std_mut().process_group(0);
}

pub async fn terminate_process_tree(child: &mut Child) -> io::Result<()> {
    let Some(process_id) = child.id() else {
        return Ok(());
    };
    kill_process_group(process_id as libc::pid_t)?;
    child.wait().await.map(|_| ())
}

fn kill_process_group(process_group: libc::pid_t) -> io::Result<()> {
    // the sidecar PID is its process-group ID, so the negative ID targets only its tree
    let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

fn reap_process(process_id: libc::pid_t) {
    let mut status = 0;
    loop {
        // this PID came from the child owned by the guard
        let result = unsafe { libc::waitpid(process_id, &mut status, 0) };
        if result >= 0 || io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webkit_defaults_force_the_portable_renderer() {
        assert_eq!(
            webkit_env_defaults(false, false),
            vec![
                ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
                ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
            ]
        );
    }

    #[test]
    fn webkit_defaults_can_keep_compositing_or_full_acceleration() {
        assert_eq!(
            webkit_env_defaults(false, true),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
        assert!(webkit_env_defaults(true, false).is_empty());
        assert!(webkit_env_defaults(true, true).is_empty());
    }

    #[test]
    fn bundled_gio_module_dir_needs_an_appimage_with_that_directory() {
        assert_eq!(bundled_gio_module_dir(None), None);

        let base = std::env::temp_dir().join(format!("tuck-gio-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(bundled_gio_module_dir(Some(base.join("absent"))), None);

        let appdir = base.join("AppDir");
        let modules = appdir.join("usr/lib/x86_64-linux-gnu/gio/modules");
        std::fs::create_dir_all(&modules).expect("test AppDir should be creatable");
        assert_eq!(bundled_gio_module_dir(Some(appdir)), Some(modules));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn set_default_env_keeps_an_explicit_choice() {
        let key = "TUCK_TEST_SET_DEFAULT_ENV";
        std::env::remove_var(key);
        set_default_env(key, "portable");
        assert_eq!(std::env::var(key).as_deref(), Ok("portable"));
        set_default_env(key, "accelerated");
        assert_eq!(std::env::var(key).as_deref(), Ok("portable"));
        std::env::remove_var(key);
    }

    #[test]
    fn env_flag_treats_empty_and_zero_as_unset() {
        let key = "TUCK_TEST_ENV_FLAG";
        std::env::remove_var(key);
        assert!(!env_flag_is_set(key));
        std::env::set_var(key, "");
        assert!(!env_flag_is_set(key));
        std::env::set_var(key, "0");
        assert!(!env_flag_is_set(key));
        std::env::set_var(key, "1");
        assert!(env_flag_is_set(key));
        std::env::remove_var(key);
    }

    #[tokio::test]
    async fn child_is_its_own_process_group_and_guard_reaps_it() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        configure_child_process(&mut command);
        let child = command.spawn().expect("test child should start");
        let process_id = child.id().expect("test child should have an ID") as libc::pid_t;
        assert_eq!(unsafe { libc::getpgid(process_id) }, process_id);

        let guard = ProcessTreeGuard::attach(&child).expect("child should be supervised");
        drop(guard);

        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(process_id, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
}
