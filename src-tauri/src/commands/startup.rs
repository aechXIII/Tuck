use std::sync::Mutex;

use tauri::{Emitter, Manager};

use crate::backend::protocol::PublicBackendError;
use crate::platform::startup::{deliver_second_instance_args, normalize_startup_args};

pub struct StartupState {
    pub files: Mutex<Vec<String>>,
}

impl StartupState {
    pub fn new(files: Vec<String>) -> Self {
        Self {
            files: Mutex::new(files),
        }
    }
    pub fn get(&self) -> Vec<String> {
        self.files.lock().unwrap().clone()
    }
    pub fn set(&self, files: Vec<String>) {
        *self.files.lock().unwrap() = files;
    }
}

pub fn extract_startup_args() -> Vec<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    normalize_startup_args(args)
}

#[tauri::command]
pub fn get_startup_files(state: tauri::State<'_, StartupState>) -> Vec<String> {
    state.get()
}

// Second instance handling: normalize and attempt to deliver via event
pub fn handle_second_instance(
    app: &tauri::AppHandle,
    args: Vec<String>,
) -> Result<(), PublicBackendError> {
    let files = normalize_startup_args(args);
    if files.is_empty() {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Second instance has no valid files.",
        ));
    }
    // Try to deliver to primary window via event; if primary not available, error
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("second-instance", &files);
        // Also update startup state
        if let Some(state) = app.try_state::<StartupState>() {
            state.set(files);
        }
        // Focus window
        let _ = window.set_focus();
        Ok(())
    } else {
        Err(PublicBackendError::new(
            "BACKEND_EXITED",
            "Primary window not available for second instance.",
        ))
    }
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
