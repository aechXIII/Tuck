//! Signed application auto-update.
//!
//! The frontend keeps its four-step flow of check, download, poll progress, and
//! install. This module implements it with `tauri-plugin-updater`. The update
//! package is signature-verified against the public key in `tauri.conf.json`
//! when it is downloaded, before it can be installed. Auto-update is Windows +
//! Linux, packaged builds only. On Linux the running binary must be a writable
//! AppImage. When it is not, installing fails and the frontend shows the release
//! notes with a manual download link instead.
//!
//! Downloading and installing are separate steps so the page can ask before
//! running exports are stopped, and so a failed step can be retried: the checked
//! update stays pending, and a verified download is kept, until install succeeds.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::backend::protocol::PublicBackendError;
use crate::backend::BackendState;
use crate::commands::lifecycle::{shut_down_backend, CloseState};
use crate::platform::capabilities::{capabilities_for_target, current_capabilities};

/// The install failed after Tuck had already stopped its backend for the installer.
pub const UPDATE_BACKEND_STOPPED: &str = "UPDATE_BACKEND_STOPPED";

/// Guard shared by every updater command.
pub fn ensure_updates_allowed(platform: &str, packaged: bool) -> Result<(), PublicBackendError> {
    let caps = capabilities_for_target(platform, packaged);
    if !caps.automatic_updater {
        return Err(PublicBackendError::new(
            "UNSUPPORTED_OPERATION",
            "Automatic updates are not supported on this platform.",
        ));
    }
    if !packaged {
        return Err(PublicBackendError::new(
            "UNSUPPORTED_OPERATION",
            "Automatic updates are only available in packaged builds.",
        ));
    }
    Ok(())
}

#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<tauri_plugin_updater::Update>>,
    download: Arc<Mutex<Download>>,
}

#[derive(Default)]
struct Download {
    /// version the verified bytes belong to
    version: Option<String>,
    downloading: bool,
    downloaded: u64,
    total: u64,
    bytes: Option<Vec<u8>>,
    error: Option<String>,
}

impl Download {
    fn is_done_for(&self, version: &str) -> bool {
        self.bytes.is_some() && self.version.as_deref() == Some(version)
    }

    /// Starts a download, or reports that none is needed because one is
    /// running or already finished for this version.
    fn begin(&mut self, version: &str) -> bool {
        if self.version.as_deref() == Some(version) && (self.downloading || self.bytes.is_some()) {
            return false;
        }
        *self = Download {
            version: Some(version.to_owned()),
            downloading: true,
            ..Download::default()
        };
        true
    }

    fn finish(&mut self, version: &str, outcome: Result<Vec<u8>, String>) {
        // a newer check replaced this download; its result no longer applies
        if self.version.as_deref() != Some(version) {
            return;
        }
        self.downloading = false;
        match outcome {
            Ok(bytes) => self.bytes = Some(bytes),
            Err(error) => self.error = Some(error),
        }
    }

    fn progress(&self) -> DownloadProgress {
        let percent = if self.total > 0 {
            ((self.downloaded as f64 / self.total as f64) * 1000.0).round() / 10.0
        } else {
            0.0
        };
        DownloadProgress {
            downloading: self.downloading,
            progress: percent,
            done: self.bytes.is_some(),
            error: self.error.clone(),
        }
    }
}

#[derive(Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Serialize)]
pub struct DownloadProgress {
    pub downloading: bool,
    pub progress: f64,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn updater_error(context: &str, error: impl std::fmt::Display) -> PublicBackendError {
    PublicBackendError::new("UPDATE_FAILED", format!("{context}: {error}"))
}

fn no_pending_update() -> PublicBackendError {
    PublicBackendError::new(
        "UPDATE_FAILED",
        "No update is pending. Check for updates first.",
    )
}

/// The checked update stays in place so a failed download or install can be retried.
fn pending_update<T: Clone>(slot: &Mutex<Option<T>>) -> Result<T, PublicBackendError> {
    slot.lock().unwrap().clone().ok_or_else(no_pending_update)
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<UpdateCheckResult, PublicBackendError> {
    let caps = current_capabilities();
    ensure_updates_allowed(&caps.platform, caps.packaged)?;

    let exit_app = app.clone();
    let updater = app
        .updater_builder()
        // Windows runs this just before it starts the installer and exits, so
        // exports are cancelled and their partial files removed first
        .on_before_exit(move || {
            // the installer ends the app without an exit event, so the window is saved here
            crate::platform::window_state::save(&exit_app);
            if let Some(close) = exit_app.try_state::<CloseState>() {
                close.begin_exit();
            }
            tauri::async_runtime::block_on(shut_down_backend(&exit_app));
        })
        .build()
        .map_err(|error| updater_error("updater is not configured for this build", error))?;
    let update = updater
        .check()
        .await
        .map_err(|error| updater_error("could not check for updates", error))?;

    let mut pending = state.pending.lock().unwrap();
    match update {
        None => {
            *pending = None;
            Ok(UpdateCheckResult {
                available: false,
                version: None,
                notes: None,
            })
        }
        Some(update) => {
            let version = update.version.clone();
            let notes = update.body.clone();
            *pending = Some(update);
            let mut download = state.download.lock().unwrap();
            if download.version.as_deref() != Some(version.as_str()) {
                *download = Download::default();
            }
            Ok(UpdateCheckResult {
                available: true,
                version: Some(version),
                notes,
            })
        }
    }
}

#[tauri::command]
pub async fn download_update(state: State<'_, UpdaterState>) -> Result<(), PublicBackendError> {
    let update = pending_update(&state.pending)?;
    let version = update.version.clone();
    if !state.download.lock().unwrap().begin(&version) {
        return Ok(());
    }

    let download = state.download.clone();
    let on_chunk = download.clone();
    let chunk_version = version.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = update
            .download(
                move |chunk, total| {
                    if let Ok(mut state) = on_chunk.lock() {
                        if state.version.as_deref() != Some(chunk_version.as_str()) {
                            return;
                        }
                        state.downloaded = state.downloaded.saturating_add(chunk as u64);
                        if let Some(total) = total {
                            state.total = total;
                        }
                    }
                },
                || {},
            )
            .await
            .map_err(|error| error.to_string());
        if let Ok(mut state) = download.lock() {
            state.finish(&version, outcome);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn get_download_progress(state: State<'_, UpdaterState>) -> DownloadProgress {
    state.download.lock().unwrap().progress()
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), PublicBackendError> {
    let update = pending_update(&state.pending)?;
    let bytes = {
        let mut download = state.download.lock().unwrap();
        if let Some(error) = download.error.clone() {
            return Err(updater_error("update failed", error));
        }
        if !download.is_done_for(&update.version) {
            return Err(PublicBackendError::new(
                "UPDATE_FAILED",
                "The update has not finished downloading.",
            ));
        }
        download.bytes.take().unwrap_or_default()
    };

    if let Some(close) = app.try_state::<CloseState>() {
        claim_exit_before_install(&close, &current_capabilities().platform);
    }
    let installer = update.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let result = installer.install(&bytes);
        (result, bytes)
    })
    .await;
    let failure = match joined {
        Ok((Ok(()), _)) => None,
        Ok((Err(error), bytes)) => {
            // keep the verified download so the install can be tried again
            state.download.lock().unwrap().bytes = Some(bytes);
            Some(error.to_string())
        }
        Err(error) => Some(error.to_string()),
    };
    if let Some(error) = failure {
        // the exit was claimed before or during install(); the window must still close
        if let Some(close) = app.try_state::<CloseState>() {
            close.reopen();
        }
        let backend_running = match app.try_state::<BackendState>() {
            Some(backend) => backend.is_running().await,
            None => false,
        };
        return Err(install_failure(error, backend_running));
    }

    // Windows has already exited inside install(). Linux swapped the AppImage
    // and needs a restart, after the backend has stopped its exports cleanly.
    if let Some(close) = app.try_state::<CloseState>() {
        close.begin_exit();
    }
    shut_down_backend(&app).await;
    app.restart();
}

/// Linux swaps the AppImage inside install() and restarts afterwards, so the exit is
/// claimed first: a close request during the swap must not destroy the window before
/// the restart. Windows claims it in `on_before_exit`, just before the installer starts.
fn claim_exit_before_install(close: &CloseState, platform: &str) {
    if platform == "linux" {
        close.begin_exit();
    }
}

/// Windows stops the backend in `on_before_exit` before it launches the installer, so a
/// launch that fails (antivirus, policy) leaves Tuck without its backend. The page then
/// needs a restart rather than another try, and a distinct code tells it so.
fn install_failure(error: String, backend_running: bool) -> PublicBackendError {
    if backend_running {
        return updater_error("could not install the update", error);
    }
    PublicBackendError::new(
        UPDATE_BACKEND_STOPPED,
        format!("the installer did not start after Tuck stopped its work: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::lifecycle::CloseDecision;

    #[test]
    fn dev_builds_reject_updates_on_every_platform() {
        for platform in ["windows", "linux"] {
            let err = ensure_updates_allowed(platform, false).unwrap_err();
            assert_eq!(err.code, "UNSUPPORTED_OPERATION");
            assert!(err.message.contains("packaged"));
        }
    }

    #[test]
    fn packaged_windows_and_linux_both_allow_updates() {
        assert!(ensure_updates_allowed("windows", true).is_ok());
        assert!(ensure_updates_allowed("linux", true).is_ok());
    }

    #[test]
    fn unknown_platform_is_rejected() {
        let err = ensure_updates_allowed("macos", true).unwrap_err();
        assert_eq!(err.code, "UNSUPPORTED_OPERATION");
    }

    #[test]
    fn the_pending_update_survives_a_download_attempt() {
        let slot = Mutex::new(Some("0.6.0".to_owned()));
        assert_eq!(pending_update(&slot).unwrap(), "0.6.0");
        assert_eq!(pending_update(&slot).unwrap(), "0.6.0");
        let empty: Mutex<Option<String>> = Mutex::new(None);
        assert_eq!(pending_update(&empty).unwrap_err().code, "UPDATE_FAILED");
    }

    #[test]
    fn a_failed_download_can_be_retried() {
        let mut download = Download::default();
        assert!(download.begin("0.6.0"));
        // a second click while the download runs does not start another one
        assert!(!download.begin("0.6.0"));
        download.finish("0.6.0", Err("connection reset".into()));
        let progress = download.progress();
        assert!(!progress.downloading && !progress.done);
        assert_eq!(progress.error.as_deref(), Some("connection reset"));

        assert!(download.begin("0.6.0"));
        assert!(download.progress().error.is_none());
        download.finish("0.6.0", Ok(vec![1, 2, 3]));
        assert!(download.progress().done);
        assert!(download.is_done_for("0.6.0"));
        // a finished download is reused instead of fetched again
        assert!(!download.begin("0.6.0"));
    }

    #[test]
    fn a_download_for_an_older_check_does_not_count_for_a_newer_one() {
        let mut download = Download::default();
        assert!(download.begin("0.6.0"));
        assert!(download.begin("0.6.1"));
        download.finish("0.6.0", Ok(vec![1]));
        assert!(!download.progress().done);
        assert!(!download.is_done_for("0.6.0"));
    }

    #[test]
    fn an_install_that_fails_after_the_backend_stopped_asks_for_a_restart() {
        let stopped = install_failure("access denied".into(), false);
        assert_eq!(stopped.code, UPDATE_BACKEND_STOPPED);
        assert!(stopped.message.contains("access denied"));
        let retryable = install_failure("access denied".into(), true);
        assert_eq!(retryable.code, "UPDATE_FAILED");
        assert!(retryable.message.contains("access denied"));
    }

    #[test]
    fn linux_holds_off_close_requests_while_the_appimage_is_swapped() {
        let close = CloseState::default();
        claim_exit_before_install(&close, "linux");
        // a close request mid-swap is ignored instead of destroying the window
        assert_eq!(close.on_close_requested(true), CloseDecision::Ignore);
        assert_eq!(close.begin_exit(), CloseDecision::Ignore);
        // a failed swap hands closing back to the page
        close.reopen();
        assert!(matches!(
            close.on_close_requested(true),
            CloseDecision::AskPage(_)
        ));

        // Windows claims the exit in its own hook, right before the installer starts
        let windows = CloseState::default();
        claim_exit_before_install(&windows, "windows");
        assert!(matches!(
            windows.on_close_requested(true),
            CloseDecision::AskPage(_)
        ));
    }

    #[test]
    fn progress_is_reported_in_tenths_of_a_percent() {
        let download = Download {
            version: Some("0.6.0".into()),
            downloading: true,
            downloaded: 1,
            total: 3,
            ..Download::default()
        };
        assert_eq!(download.progress().progress, 33.3);
    }
}
