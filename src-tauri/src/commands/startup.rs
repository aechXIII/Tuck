use std::sync::Mutex;

use tauri::{Emitter, Manager};

use crate::backend::protocol::PublicBackendError;
use crate::platform::startup::{deliver_second_instance_args, normalize_startup_args};

pub struct StartupState {
    launch: Mutex<LaunchDelivery>,
}

struct LaunchDelivery {
    files: Vec<String>,
    buffered_second_instance_files: Vec<Vec<String>>,
    event_delivery_enabled: bool,
}

impl StartupState {
    pub fn new(files: Vec<String>) -> Self {
        Self {
            launch: Mutex::new(LaunchDelivery {
                files,
                buffered_second_instance_files: Vec::new(),
                event_delivery_enabled: false,
            }),
        }
    }
    pub fn get(&self) -> Vec<String> {
        self.launch.lock().unwrap().files.clone()
    }
    pub fn set(&self, files: Vec<String>) {
        self.launch.lock().unwrap().files = files;
    }

    /// Returns whether the files must be delivered through the Tauri event.
    pub fn deliver_second_instance_files(&self, files: Vec<String>) -> bool {
        let mut launch = self.launch.lock().unwrap();
        if launch.event_delivery_enabled {
            true
        } else {
            launch.buffered_second_instance_files.push(files);
            false
        }
    }

    pub fn take_launch_files_and_enable_event_delivery(&self) -> Vec<String> {
        let mut launch = self.launch.lock().unwrap();
        let buffered_files = std::mem::take(&mut launch.buffered_second_instance_files);
        launch.files.extend(buffered_files.into_iter().flatten());
        launch.event_delivery_enabled = true;
        std::mem::take(&mut launch.files)
    }
}

pub fn extract_startup_args() -> Vec<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    normalize_startup_args(args)
}

#[tauri::command]
pub fn get_startup_files(state: tauri::State<'_, StartupState>) -> Vec<String> {
    state.take_launch_files_and_enable_event_delivery()
}

// Second instance handling: normalize and attempt to deliver via event
pub fn handle_second_instance(
    app: &tauri::AppHandle,
    args: Vec<String>,
) -> Result<(), PublicBackendError> {
    // The single-instance plugin forwards std::env::args(), including the
    // executable path. Startup extraction already skips that first argument.
    let files = normalize_startup_args(args.into_iter().skip(1).collect());
    let window = app.get_webview_window("main").ok_or_else(|| {
        PublicBackendError::new(
            "BACKEND_EXITED",
            "Primary window not available for second instance.",
        )
    })?;
    // Opening Tuck again should still bring its existing window forward even
    // when the second process did not receive a media-file argument.
    let _ = window.set_focus();
    if files.is_empty() {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Second instance has no valid files.",
        ));
    }
    if let Some(state) = app.try_state::<StartupState>() {
        if state.deliver_second_instance_files(files.clone()) {
            let _ = window.emit("second-instance", &files);
        }
    } else {
        // A running Tauri app always manages StartupState. Preserve delivery if
        // a future shell configuration omits it rather than dropping files.
        let _ = window.emit("second-instance", &files);
    }
    Ok(())
}

pub fn try_forward_to_primary<F>(args: Vec<String>, forwarder: F) -> Result<(), PublicBackendError>
where
    F: Fn(Vec<String>) -> Result<(), String>,
{
    deliver_second_instance_args(args, forwarder).map_err(|e| {
        if e == "SECOND_INSTANCE_NO_FILES" {
            PublicBackendError::new("INVALID_REQUEST", "No valid files to forward.")
        } else {
            PublicBackendError::new("BACKEND_EXITED", "Could not forward to primary instance.")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn startup_state_round_trip() {
        let state = StartupState::new(vec!["a".to_owned()]);
        assert_eq!(state.get(), vec!["a"]);
        state.set(vec!["b".to_owned(), "c".to_owned()]);
        assert_eq!(state.get(), vec!["b", "c"]);
    }

    #[test]
    fn startup_state_drains_initial_and_buffered_second_instance_files() {
        let state = StartupState::new(vec!["initial.mp4".to_owned()]);
        assert!(!state.deliver_second_instance_files(vec!["later.mp4".to_owned()]));

        assert_eq!(
            state.take_launch_files_and_enable_event_delivery(),
            vec!["initial.mp4".to_owned(), "later.mp4".to_owned()]
        );
        assert!(state
            .take_launch_files_and_enable_event_delivery()
            .is_empty());
    }

    #[test]
    fn listener_registered_before_startup_drain_uses_only_the_buffered_delivery() {
        let state = StartupState::new(Vec::new());

        // The WebView has installed its listener but has not yet completed the
        // startup command that confirms event delivery is safe.
        assert!(!state.deliver_second_instance_files(vec!["before-ready.mp4".to_owned()]));
        assert_eq!(
            state.take_launch_files_and_enable_event_delivery(),
            vec!["before-ready.mp4".to_owned()]
        );

        // later forwards use the event and are no longer included in startup
        assert!(state.deliver_second_instance_files(vec!["after-ready.mp4".to_owned()]));
        assert!(state
            .take_launch_files_and_enable_event_delivery()
            .is_empty());
    }

    #[test]
    fn forward_fails_without_files() {
        let result = try_forward_to_primary(vec!["--flag".to_owned()], |_| Ok(()));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "INVALID_REQUEST");
    }

    #[test]
    fn forward_succeeds_with_files() {
        let dir = std::env::temp_dir().join("tuck_startup_forward");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("e.mp4");
        fs::write(&file, b"").unwrap();
        let canonical = fs::canonicalize(&file)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let result = try_forward_to_primary(vec![file.to_string_lossy().to_string()], |files| {
            assert_eq!(files, vec![canonical.clone()]);
            Ok(())
        });
        assert!(result.is_ok());
        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn forward_reports_primary_failure() {
        let dir = std::env::temp_dir().join("tuck_forward_fail2");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("f.mp4");
        fs::write(&file, b"").unwrap();
        let result = try_forward_to_primary(vec![file.to_string_lossy().to_string()], |_| {
            Err("PRIMARY_UNAVAILABLE".to_owned())
        });
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "BACKEND_EXITED");
        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&dir);
    }
}
