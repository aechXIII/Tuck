//! Signed application auto-update.
//!
//! The frontend keeps its four-step flow of check, download, poll progress, and
//! install. This module implements it with `tauri-plugin-updater`. The update
//! package is signature-verified against the public key in `tauri.conf.json`
//! before it is applied. Auto-update is Windows + Linux, packaged builds only.
//! On Linux the running binary must be a writable AppImage. When it is not, the
//! download fails and the frontend shows the release notes with a manual
//! download link instead.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::backend::protocol::PublicBackendError;
use crate::platform::capabilities::{capabilities_for_target, current_capabilities};

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
    progress: Arc<Mutex<DownloadState>>,
}

#[derive(Default, Clone)]
struct DownloadState {
    downloading: bool,
    downloaded: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
}

#[derive(Serialize)]
pub struct DownloadProgress {
    pub downloading: bool,
    pub progress: f64,
    pub done: bool,
    pub error: Option<String>,
}

fn updater_error(context: &str, error: impl std::fmt::Display) -> PublicBackendError {
    PublicBackendError::new("UPDATE_FAILED", format!("{context}: {error}"))
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<UpdateCheckResult, PublicBackendError> {
    let caps = current_capabilities();
    ensure_updates_allowed(&caps.platform, caps.packaged)?;

    let updater = app
        .updater()
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
            *state.progress.lock().unwrap() = DownloadState::default();
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
    let update = state.pending.lock().unwrap().take().ok_or_else(|| {
        PublicBackendError::new(
            "UPDATE_FAILED",
            "No update is pending. Check for updates first.",
        )
    })?;

    let progress = state.progress.clone();
    *progress.lock().unwrap() = DownloadState {
        downloading: true,
        ..DownloadState::default()
    };
    let on_chunk_progress = progress.clone();

    tauri::async_runtime::spawn(async move {
        let outcome = update
            .download_and_install(
                move |chunk, total| {
                    if let Ok(mut state) = on_chunk_progress.lock() {
                        state.downloaded = state.downloaded.saturating_add(chunk as u64);
                        if let Some(total) = total {
                            state.total = total;
                        }
                    }
                },
                || {},
            )
            .await;

        if let Ok(mut state) = progress.lock() {
            state.downloading = false;
            match outcome {
                Ok(()) => state.done = true,
                Err(error) => state.error = Some(error.to_string()),
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn get_download_progress(state: State<'_, UpdaterState>) -> DownloadProgress {
    let snapshot = state.progress.lock().unwrap().clone();
    let percent = if snapshot.total > 0 {
        ((snapshot.downloaded as f64 / snapshot.total as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };
    DownloadProgress {
        downloading: snapshot.downloading && !snapshot.done && snapshot.error.is_none(),
        progress: percent,
        done: snapshot.done,
        error: snapshot.error,
    }
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), PublicBackendError> {
    let snapshot = state.progress.lock().unwrap().clone();
    if let Some(error) = snapshot.error {
        return Err(updater_error("update failed", error));
    }
    if !snapshot.done {
        return Err(PublicBackendError::new(
            "UPDATE_FAILED",
            "The update has not finished downloading.",
        ));
    }
    // Windows already exited inside install(). Linux needs the swapped AppImage to run.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
