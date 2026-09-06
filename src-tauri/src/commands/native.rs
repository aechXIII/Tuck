use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

use crate::backend::protocol::PublicBackendError;
use crate::platform::capabilities::{current_capabilities, PlatformCapabilities};
use crate::platform::opener::{
    open_app_folder_with_validation, open_with_validation, SystemOpener,
};

#[tauri::command]
pub fn platform_capabilities() -> PlatformCapabilities {
    current_capabilities()
}

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "wmv", "m4v", "flv"];
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "aac", "ogg", "wma", "m4a", "opus"];

fn paths_to_strings(paths: Vec<tauri_plugin_dialog::FilePath>) -> Vec<String> {
    paths
        .into_iter()
        .filter_map(|p| p.as_path().map(|path| path.display().to_string()))
        .collect()
}

fn path_opt_to_string(path: Option<tauri_plugin_dialog::FilePath>) -> String {
    path.and_then(|p| p.as_path().map(|path| path.display().to_string()))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn pick_video_files(window: tauri::Window) -> Result<Vec<String>, PublicBackendError> {
    let files = window
        .dialog()
        .file()
        .add_filter("Video files", VIDEO_EXTENSIONS)
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    Ok(paths_to_strings(files.unwrap_or_default()))
}

#[tauri::command]
pub async fn pick_audio_files(window: tauri::Window) -> Result<Vec<String>, PublicBackendError> {
    let files = window
        .dialog()
        .file()
        .add_filter("Audio files", AUDIO_EXTENSIONS)
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    Ok(paths_to_strings(files.unwrap_or_default()))
}

#[tauri::command]
pub async fn pick_folder(window: tauri::Window) -> Result<String, PublicBackendError> {
    let folder = window.dialog().file().blocking_pick_folder();
    Ok(path_opt_to_string(folder))
}

#[tauri::command]
pub async fn pick_ffmpeg_file(window: tauri::Window) -> Result<String, PublicBackendError> {
    let file = window
        .dialog()
        .file()
        .add_filter("Executable", &["exe", ""])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    Ok(path_opt_to_string(file))
}

#[tauri::command]
pub async fn pick_ffprobe_file(window: tauri::Window) -> Result<String, PublicBackendError> {
    let file = window
        .dialog()
        .file()
        .add_filter("Executable", &["exe", ""])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    Ok(path_opt_to_string(file))
}

#[tauri::command]
pub async fn pick_import_file(window: tauri::Window) -> Result<String, PublicBackendError> {
    let file = window
        .dialog()
        .file()
        .add_filter("JSON profiles", &["json"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    Ok(path_opt_to_string(file))
}

#[tauri::command]
pub async fn pick_save_file(
    window: tauri::Window,
    default_name: Option<String>,
) -> Result<String, PublicBackendError> {
    let mut dialog = window.dialog().file();
    if let Some(name) = default_name {
        dialog = dialog.set_file_name(name);
    }
    let file = dialog.add_filter("JSON", &["json"]).blocking_save_file();
    Ok(path_opt_to_string(file))
}

const MAX_CLIPBOARD_BYTES: usize = 10 * 1024 * 1024;

fn validate_clipboard_text(text: &str) -> Result<(), PublicBackendError> {
    if text.is_empty() {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Nothing to copy.",
        ));
    }
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Text too large to copy.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn copy_text(app: tauri::AppHandle, text: String) -> Result<(), PublicBackendError> {
    validate_clipboard_text(&text)?;
    app.clipboard()
        .write_text(text)
        .map_err(|_| PublicBackendError::new("INTERNAL_ERROR", "Could not write to the clipboard."))
}

#[tauri::command]
pub async fn open_output_folder(path: String) -> Result<(), PublicBackendError> {
    let opener = SystemOpener;
    open_with_validation(&path, &opener)
}

#[tauri::command]
pub async fn open_logs_folder(app: tauri::AppHandle) -> Result<(), PublicBackendError> {
    let base = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("tuck_logs"));
    let opener = SystemOpener;
    open_app_folder_with_validation(&base, &opener)
}

#[tauri::command]
pub async fn open_config_folder(app: tauri::AppHandle) -> Result<(), PublicBackendError> {
    let base = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("tuck_config"));
    let opener = SystemOpener;
    open_app_folder_with_validation(&base, &opener)
}

#[tauri::command]
pub async fn close_window(window: tauri::Window) -> Result<(), PublicBackendError> {
    window
        .close()
        .map_err(|_| PublicBackendError::new("INTERNAL_ERROR", "Could not close window."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_text_empty_is_rejected() {
        let err = validate_clipboard_text("").unwrap_err();
        assert_eq!(err.code, "INVALID_REQUEST");
    }

    #[test]
    fn clipboard_text_large_is_rejected() {
        let large = "a".repeat(MAX_CLIPBOARD_BYTES + 1);
        let err = validate_clipboard_text(&large).unwrap_err();
        assert_eq!(err.code, "INVALID_REQUEST");
    }

    #[test]
    fn clipboard_text_valid_passes_validation() {
        assert!(validate_clipboard_text("hello").is_ok());
    }
}
