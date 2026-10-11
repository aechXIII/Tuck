//! Closing and restarting the app without losing work silently.
//!
//! Every way of closing the main window (the title bar, Alt+F4, the window menu,
//! the exit shortcut) arrives as one close request. While the backend is running,
//! the shell asks the page first because the page knows whether exports are
//! running and owns the confirmation dialog. The page acknowledges the request
//! straight away and confirms when the window may close; a page that never
//! acknowledges cannot show a dialog, so the shell closes on its own after a
//! short wait instead of leaving a window that will not close.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::backend::{BackendState, PublicBackendError};

pub const CLOSE_REQUESTED_EVENT: &str = "close-requested";
const CLOSE_ACK_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Open,
    Asking { request: u64, acknowledged: bool },
    Closing,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseDecision {
    /// ask the page, and close anyway if it has not acknowledged in time
    AskPage(u64),
    ShutDown,
    Ignore,
}

/// Decides what each close request, page answer and timeout means. Kept free of
/// Tauri types so the rules can be tested directly.
pub struct CloseState {
    flow: Mutex<CloseFlow>,
}

struct CloseFlow {
    phase: Phase,
    next_request: u64,
}

impl Default for CloseState {
    fn default() -> Self {
        Self {
            flow: Mutex::new(CloseFlow {
                phase: Phase::Open,
                next_request: 1,
            }),
        }
    }
}

impl CloseState {
    pub fn on_close_requested(&self, backend_running: bool) -> CloseDecision {
        let mut flow = self.flow.lock().unwrap();
        match flow.phase {
            Phase::Closing => CloseDecision::Ignore,
            // nothing can be lost when the backend is not serving work
            _ if !backend_running => {
                flow.phase = Phase::Closing;
                CloseDecision::ShutDown
            }
            // asking again shows the dialog again; each request gets its own deadline
            Phase::Open | Phase::Asking { .. } => {
                let request = flow.next_request;
                flow.next_request += 1;
                flow.phase = Phase::Asking {
                    request,
                    acknowledged: false,
                };
                CloseDecision::AskPage(request)
            }
        }
    }

    pub fn on_acknowledged(&self, request: u64) {
        let mut flow = self.flow.lock().unwrap();
        if let Phase::Asking {
            request: current, ..
        } = flow.phase
        {
            if current == request {
                flow.phase = Phase::Asking {
                    request,
                    acknowledged: true,
                };
            }
        }
    }

    pub fn on_ack_timeout(&self, request: u64) -> CloseDecision {
        let mut flow = self.flow.lock().unwrap();
        match flow.phase {
            Phase::Asking {
                request: current,
                acknowledged: false,
            } if current == request => {
                flow.phase = Phase::Closing;
                CloseDecision::ShutDown
            }
            _ => CloseDecision::Ignore,
        }
    }

    pub fn on_confirmed(&self) -> CloseDecision {
        self.begin_exit()
    }

    /// Claims the exit for a caller that shuts down by itself (restart, update).
    pub fn begin_exit(&self) -> CloseDecision {
        let mut flow = self.flow.lock().unwrap();
        if flow.phase == Phase::Closing {
            return CloseDecision::Ignore;
        }
        flow.phase = Phase::Closing;
        CloseDecision::ShutDown
    }

    /// The window outlived a failed close, so later requests must be handled again.
    pub fn reopen(&self) {
        self.flow.lock().unwrap().phase = Phase::Open;
    }
}

#[derive(Clone, Serialize)]
struct CloseRequest {
    request: u64,
}

/// Handles the main window's close request. The caller has already prevented
/// the default close.
pub fn handle_close_request(window: &tauri::Window) {
    let app = window.app_handle().clone();
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let Some(close) = app.try_state::<CloseState>() else {
            return;
        };
        let running = match app.try_state::<BackendState>() {
            Some(backend) => backend.is_running().await,
            None => false,
        };
        match close.on_close_requested(running) {
            CloseDecision::Ignore => {}
            CloseDecision::ShutDown => shut_down_and_close(&app, &window).await,
            CloseDecision::AskPage(request) => {
                if window
                    .emit(CLOSE_REQUESTED_EVENT, CloseRequest { request })
                    .is_err()
                {
                    eprintln!("could not ask the page before closing");
                }
                tokio::time::sleep(CLOSE_ACK_TIMEOUT).await;
                if close.on_ack_timeout(request) == CloseDecision::ShutDown {
                    eprintln!("the page did not answer the close request; closing anyway");
                    shut_down_and_close(&app, &window).await;
                }
            }
        }
    });
}

async fn shut_down_and_close(app: &tauri::AppHandle, window: &tauri::Window) {
    shut_down_backend(app).await;
    if let Err(error) = window.destroy() {
        if let Some(close) = app.try_state::<CloseState>() {
            close.reopen();
        }
        eprintln!("could not close the window: {error}");
    }
}

/// Stops the backend gracefully so it can cancel exports and remove their
/// partial files before the shell exits.
pub async fn shut_down_backend(app: &tauri::AppHandle) {
    if let Some(backend) = app.try_state::<BackendState>() {
        if let Err(error) = backend.shutdown().await {
            eprintln!("could not shut down the backend: {error}");
        }
    }
}

#[tauri::command]
pub fn acknowledge_close_request(close: tauri::State<'_, CloseState>, request: u64) {
    close.on_acknowledged(request);
}

/// The page has confirmed, or found nothing to lose: stop the backend and close.
#[tauri::command]
pub async fn confirm_close(
    app: tauri::AppHandle,
    window: tauri::Window,
    close: tauri::State<'_, CloseState>,
) -> Result<(), PublicBackendError> {
    if close.on_confirmed() == CloseDecision::ShutDown {
        shut_down_and_close(&app, &window).await;
    }
    Ok(())
}

fn ensure_restart_allowed(backend_running: bool) -> Result<(), PublicBackendError> {
    if backend_running {
        // a running backend may be exporting; only a stopped one is restarted from the page
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Tuck is running normally, so it was not restarted.",
        ));
    }
    Ok(())
}

/// Restarts Tuck after its backend could not start or stopped unexpectedly.
#[tauri::command]
pub async fn restart_app(
    app: tauri::AppHandle,
    backend: tauri::State<'_, BackendState>,
    close: tauri::State<'_, CloseState>,
) -> Result<(), PublicBackendError> {
    ensure_restart_allowed(backend.is_running().await)?;
    close.begin_exit();
    // reap whatever is left of the old backend before the new shell starts one
    shut_down_backend(&app).await;
    app.restart();
}

/// The page died with the GPU renderer, so nothing on screen can be saved or asked
/// about. The platform layer has already chosen software drawing for the next launch,
/// so a restart brings the editor back instead of leaving a blank window.
#[cfg(target_os = "linux")]
pub async fn restart_after_gpu_renderer_crash(app: tauri::AppHandle) {
    if let Some(close) = app.try_state::<CloseState>() {
        close.begin_exit();
    }
    shut_down_backend(&app).await;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_without_a_running_backend_needs_no_question() {
        let close = CloseState::default();
        assert_eq!(close.on_close_requested(false), CloseDecision::ShutDown);
        assert_eq!(close.on_close_requested(false), CloseDecision::Ignore);
        assert_eq!(close.on_close_requested(true), CloseDecision::Ignore);
    }

    #[test]
    fn a_running_backend_asks_the_page_and_waits_for_its_answer() {
        let close = CloseState::default();
        let CloseDecision::AskPage(request) = close.on_close_requested(true) else {
            panic!("a running backend must ask the page");
        };
        close.on_acknowledged(request);
        // the page is showing the dialog, so the deadline does not close the window
        assert_eq!(close.on_ack_timeout(request), CloseDecision::Ignore);
        assert_eq!(close.on_confirmed(), CloseDecision::ShutDown);
        // a second confirmation or close request never starts a second shutdown
        assert_eq!(close.on_confirmed(), CloseDecision::Ignore);
        assert_eq!(close.on_close_requested(true), CloseDecision::Ignore);
    }

    #[test]
    fn keep_working_leaves_the_window_open_until_the_next_request() {
        let close = CloseState::default();
        let CloseDecision::AskPage(first) = close.on_close_requested(true) else {
            panic!("expected a question");
        };
        close.on_acknowledged(first);
        let CloseDecision::AskPage(second) = close.on_close_requested(true) else {
            panic!("closing again asks again");
        };
        assert_ne!(first, second);
        // a late acknowledgement of the old request does not cover the new one
        close.on_acknowledged(first);
        assert_eq!(close.on_ack_timeout(first), CloseDecision::Ignore);
        assert_eq!(close.on_ack_timeout(second), CloseDecision::ShutDown);
    }

    #[test]
    fn an_unresponsive_page_cannot_keep_the_window_open() {
        let close = CloseState::default();
        let CloseDecision::AskPage(request) = close.on_close_requested(true) else {
            panic!("expected a question");
        };
        assert_eq!(close.on_ack_timeout(request), CloseDecision::ShutDown);
        assert_eq!(close.on_confirmed(), CloseDecision::Ignore);
    }

    #[test]
    fn a_failed_close_can_be_retried() {
        let close = CloseState::default();
        assert_eq!(close.on_close_requested(false), CloseDecision::ShutDown);
        close.reopen();
        assert_eq!(close.on_close_requested(false), CloseDecision::ShutDown);
    }

    #[test]
    fn an_exit_claimed_by_restart_or_update_blocks_a_second_shutdown() {
        let close = CloseState::default();
        assert_eq!(close.begin_exit(), CloseDecision::ShutDown);
        assert_eq!(close.on_close_requested(true), CloseDecision::Ignore);
        assert_eq!(close.begin_exit(), CloseDecision::Ignore);
    }

    #[test]
    fn restart_is_refused_while_the_backend_is_running() {
        assert_eq!(
            ensure_restart_allowed(true).unwrap_err().code,
            "INVALID_REQUEST"
        );
        assert!(ensure_restart_allowed(false).is_ok());
    }
}
