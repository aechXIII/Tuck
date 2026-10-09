use std::sync::Mutex;

use tauri::{Emitter, Manager};

use crate::backend::protocol::PublicBackendError;
use crate::platform::startup::{deliver_second_instance_args, parse_startup_args, StartupLaunch};

pub struct StartupState {
    launch: Mutex<LaunchDelivery>,
}

struct LaunchDelivery {
    launch: StartupLaunch,
    buffered_second_instance_launches: Vec<StartupLaunch>,
    event_delivery_enabled: bool,
}

impl StartupState {
    pub fn new(launch: StartupLaunch) -> Self {
        Self {
            launch: Mutex::new(LaunchDelivery {
                launch,
                buffered_second_instance_launches: Vec::new(),
                event_delivery_enabled: false,
            }),
        }
    }
    pub fn get(&self) -> StartupLaunch {
        self.launch.lock().unwrap().launch.clone()
    }
    pub fn set(&self, launch: StartupLaunch) {
        self.launch.lock().unwrap().launch = launch;
    }

    /// Returns whether the launch must be delivered through the Tauri event.
    pub fn deliver_second_instance_launch(&self, launch: StartupLaunch) -> bool {
        let mut delivery = self.launch.lock().unwrap();
        if delivery.event_delivery_enabled {
            true
        } else {
            delivery.buffered_second_instance_launches.push(launch);
            false
        }
    }

    pub fn take_launch_and_enable_event_delivery(&self) -> StartupLaunch {
        let mut delivery = self.launch.lock().unwrap();
        let mut launch = std::mem::take(&mut delivery.launch);
        for later in std::mem::take(&mut delivery.buffered_second_instance_launches) {
            launch.merge(later);
        }
        delivery.event_delivery_enabled = true;
        launch
    }
}

pub fn extract_startup_args() -> StartupLaunch {
    let args: Vec<String> = std::env::args().skip(1).collect();
    parse_startup_args(args)
}

#[tauri::command]
pub fn get_startup_files(state: tauri::State<'_, StartupState>) -> StartupLaunch {
    state.take_launch_and_enable_event_delivery()
}

// Second instance handling: normalize and attempt to deliver via event
pub fn handle_second_instance(
    app: &tauri::AppHandle,
    args: Vec<String>,
) -> Result<(), PublicBackendError> {
    // The single-instance plugin forwards std::env::args(), including the
    // executable path. Startup extraction already skips that first argument.
    let launch = parse_startup_args(args.into_iter().skip(1).collect());
    let window = app.get_webview_window("main").ok_or_else(|| {
        PublicBackendError::new(
            "BACKEND_EXITED",
            "Primary window not available for second instance.",
        )
    })?;
    // Opening Tuck again should still bring its existing window forward even
    // when the second process did not receive a media-file argument. Focus
    // alone does not restore a minimized or hidden window.
    bring_forward(&window);
    if launch.is_empty() {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Second instance has no valid files or task.",
        ));
    }
    if let Some(state) = app.try_state::<StartupState>() {
        if state.deliver_second_instance_launch(launch.clone()) {
            let _ = window.emit("second-instance", &launch);
        }
    } else {
        // A running Tauri app always manages StartupState. Preserve delivery if
        // a future shell configuration omits it rather than dropping files.
        let _ = window.emit("second-instance", &launch);
    }
    Ok(())
}

/// The window operations second-instance delivery needs, so their order can be tested.
pub trait ForwardableWindow {
    fn is_minimized(&self) -> bool;
    fn unminimize(&self);
    fn show(&self);
    fn set_focus(&self);
}

impl<R: tauri::Runtime> ForwardableWindow for tauri::WebviewWindow<R> {
    fn is_minimized(&self) -> bool {
        tauri::WebviewWindow::is_minimized(self).unwrap_or(false)
    }
    fn unminimize(&self) {
        let _ = tauri::WebviewWindow::unminimize(self);
    }
    fn show(&self) {
        let _ = tauri::WebviewWindow::show(self);
    }
    fn set_focus(&self) {
        let _ = tauri::WebviewWindow::set_focus(self);
    }
}

pub fn bring_forward(window: &impl ForwardableWindow) {
    if window.is_minimized() {
        window.unminimize();
    }
    window.show();
    window.set_focus();
}

pub fn try_forward_to_primary<F>(args: Vec<String>, forwarder: F) -> Result<(), PublicBackendError>
where
    F: Fn(StartupLaunch) -> Result<(), String>,
{
    deliver_second_instance_args(args, forwarder).map_err(|e| {
        if e == "SECOND_INSTANCE_NO_FILES" {
            PublicBackendError::new("INVALID_REQUEST", "No valid files or task to forward.")
        } else {
            PublicBackendError::new("BACKEND_EXITED", "Could not forward to primary instance.")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::startup::LaunchTask;
    use std::fs;

    fn files(names: &[&str]) -> StartupLaunch {
        StartupLaunch {
            files: names.iter().map(|name| (*name).to_owned()).collect(),
            task: None,
        }
    }

    struct RecordingWindow {
        minimized: bool,
        calls: std::cell::RefCell<Vec<&'static str>>,
    }

    impl ForwardableWindow for RecordingWindow {
        fn is_minimized(&self) -> bool {
            self.minimized
        }
        fn unminimize(&self) {
            self.calls.borrow_mut().push("unminimize");
        }
        fn show(&self) {
            self.calls.borrow_mut().push("show");
        }
        fn set_focus(&self) {
            self.calls.borrow_mut().push("focus");
        }
    }

    #[test]
    fn a_minimized_window_is_restored_before_it_takes_focus() {
        let window = RecordingWindow {
            minimized: true,
            calls: Default::default(),
        };
        bring_forward(&window);
        assert_eq!(*window.calls.borrow(), ["unminimize", "show", "focus"]);

        let window = RecordingWindow {
            minimized: false,
            calls: Default::default(),
        };
        bring_forward(&window);
        assert_eq!(*window.calls.borrow(), ["show", "focus"]);
    }

    #[test]
    fn startup_state_round_trip() {
        let state = StartupState::new(files(&["a"]));
        assert_eq!(state.get(), files(&["a"]));
        state.set(files(&["b", "c"]));
        assert_eq!(state.get(), files(&["b", "c"]));
    }

    #[test]
    fn startup_state_drains_initial_and_buffered_second_instance_files() {
        let state = StartupState::new(files(&["initial.mp4"]));
        assert!(!state.deliver_second_instance_launch(files(&["later.mp4"])));

        assert_eq!(
            state.take_launch_and_enable_event_delivery(),
            files(&["initial.mp4", "later.mp4"])
        );
        assert!(state.take_launch_and_enable_event_delivery().is_empty());
    }

    #[test]
    fn startup_state_keeps_the_launch_task_and_the_latest_buffered_task() {
        let state = StartupState::new(StartupLaunch {
            files: Vec::new(),
            task: Some(LaunchTask::Cut),
        });
        assert_eq!(
            state.get(),
            StartupLaunch {
                files: Vec::new(),
                task: Some(LaunchTask::Cut),
            }
        );
        assert!(!state.deliver_second_instance_launch(files(&["later.mp4"])));
        assert!(!state.deliver_second_instance_launch(StartupLaunch {
            files: Vec::new(),
            task: Some(LaunchTask::Upscale),
        }));

        assert_eq!(
            state.take_launch_and_enable_event_delivery(),
            StartupLaunch {
                files: vec!["later.mp4".to_owned()],
                task: Some(LaunchTask::Upscale),
            }
        );
        // the task is delivered once, not replayed on the next drain
        assert!(state.take_launch_and_enable_event_delivery().is_empty());
    }

    #[test]
    fn listener_registered_before_startup_drain_uses_only_the_buffered_delivery() {
        let state = StartupState::new(StartupLaunch::default());

        // The WebView has installed its listener but has not yet completed the
        // startup command that confirms event delivery is safe.
        assert!(!state.deliver_second_instance_launch(files(&["before-ready.mp4"])));
        assert_eq!(
            state.take_launch_and_enable_event_delivery(),
            files(&["before-ready.mp4"])
        );

        // later forwards use the event and are no longer included in startup
        assert!(state.deliver_second_instance_launch(files(&["after-ready.mp4"])));
        assert!(state.take_launch_and_enable_event_delivery().is_empty());
    }

    #[test]
    fn forward_fails_without_files_or_task() {
        let result = try_forward_to_primary(vec!["--flag".to_owned()], |_| Ok(()));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "INVALID_REQUEST");
    }

    #[test]
    fn forward_succeeds_with_only_a_task() {
        let result = try_forward_to_primary(
            vec!["--sendto-task".to_owned(), "cut".to_owned()],
            |launch| {
                assert_eq!(
                    launch,
                    StartupLaunch {
                        files: Vec::new(),
                        task: Some(LaunchTask::Cut),
                    }
                );
                Ok(())
            },
        );
        assert!(result.is_ok());
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
        let result = try_forward_to_primary(vec![file.to_string_lossy().to_string()], |launch| {
            assert_eq!(launch.files, vec![canonical.clone()]);
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
