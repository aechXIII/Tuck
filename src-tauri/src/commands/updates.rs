use crate::backend::protocol::PublicBackendError;
use crate::platform::capabilities::current_capabilities;

#[derive(Debug)]
pub struct UpdateCheck {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
}

// In 0.5.0, Windows packaged builds have updater enabled, but we have no signing key configured yet.
// so this is a disabled/tested adapter that clearly reports not configured or unsupported
pub fn check_for_updates_inner(
    platform: &str,
    packaged: bool,
    updater_configured: bool,
) -> Result<UpdateCheck, PublicBackendError> {
    let caps = crate::platform::capabilities::capabilities_for_target(platform, packaged);
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
    if !updater_configured {
        return Err(PublicBackendError::new(
            "UNSUPPORTED_OPERATION",
            "Updater is not configured for this build.",
        ));
    }
    // if configured, we would query the updater; for now return no update
    Ok(UpdateCheck {
        available: false,
        version: None,
        notes: None,
    })
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, PublicBackendError> {
    let caps = current_capabilities();
    let configured = false; // No public key / feed configured yet per MIGRATION_STATE
    let inner = check_for_updates_inner(&caps.platform, caps.packaged, configured)?;
    Ok(UpdateCheckResult {
        available: inner.available,
        version: inner.version,
        notes: inner.notes,
    })
}

#[derive(serde::Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn download_update() -> Result<(), PublicBackendError> {
    Err(PublicBackendError::new(
        "UNSUPPORTED_OPERATION",
        "Update download is not configured.",
    ))
}

#[tauri::command]
pub async fn install_update() -> Result<(), PublicBackendError> {
    Err(PublicBackendError::new(
        "UNSUPPORTED_OPERATION",
        "Update installation is not configured.",
    ))
}

#[tauri::command]
pub async fn get_download_progress() -> Result<DownloadProgress, PublicBackendError> {
    Ok(DownloadProgress {
        downloading: false,
        progress: 0.0,
    })
}

#[derive(serde::Serialize)]
pub struct DownloadProgress {
    pub downloading: bool,
    pub progress: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_updater_is_unsupported() {
        let err = check_for_updates_inner("linux", false, false).unwrap_err();
        assert_eq!(err.code, "UNSUPPORTED_OPERATION");
    }

    #[test]
    fn windows_dev_updater_is_unsupported() {
        let err = check_for_updates_inner("windows", false, false).unwrap_err();
        assert_eq!(err.code, "UNSUPPORTED_OPERATION");
    }

    #[test]
    fn windows_packaged_without_config_is_unsupported() {
        let err = check_for_updates_inner("windows", true, false).unwrap_err();
        assert_eq!(err.code, "UNSUPPORTED_OPERATION");
    }

    #[test]
    fn windows_packaged_with_config_succeeds_no_update() {
        let ok = check_for_updates_inner("windows", true, true).unwrap();
        assert!(!ok.available);
    }

    #[test]
    fn download_update_always_fails_without_config() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(download_update()).unwrap_err();
        assert_eq!(err.code, "UNSUPPORTED_OPERATION");
    }
}
