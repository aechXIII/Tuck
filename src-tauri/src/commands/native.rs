use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

use crate::backend::{protocol::PublicBackendError, BackendState};
use crate::commands::backend::BackendCommand;
use crate::platform::capabilities::{current_capabilities, PlatformCapabilities};
use crate::platform::file_drag;
use crate::platform::local_documents::{open_document_file, open_document_with, LocalDocument};
use crate::platform::opener::{
    launch_export, open_app_folder_with_validation, open_with_validation, SystemOpener,
};

#[tauri::command]
pub fn platform_capabilities() -> PlatformCapabilities {
    current_capabilities()
}

// the same lists as VIDEO_EXTENSIONS and AUDIO_EXTENSIONS in tuck/bridge_validation.py, which
// decides what the preview may serve; a Python test keeps the two in agreement
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "asf", "flv", "f4v", "ts", "m2ts", "mts",
    "3gp", "3g2", "ogv", "mpg", "mpeg", "m2v", "vob", "mxf",
];
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma", "aif", "aiff",
];

// owned by Tuck's window, so the dialog opens over it, on its display, and stays in front of it
fn file_dialog<R: tauri::Runtime>(
    window: &tauri::Window<R>,
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    window.dialog().file().set_parent(window)
}

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
    let files = file_dialog(&window)
        .add_filter("Video files", VIDEO_EXTENSIONS)
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    Ok(paths_to_strings(files.unwrap_or_default()))
}

#[tauri::command]
pub async fn pick_audio_files(window: tauri::Window) -> Result<Vec<String>, PublicBackendError> {
    let files = file_dialog(&window)
        .add_filter("Audio files", AUDIO_EXTENSIONS)
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    Ok(paths_to_strings(files.unwrap_or_default()))
}

#[tauri::command]
pub async fn pick_lut_file(window: tauri::Window) -> Result<String, PublicBackendError> {
    let file = file_dialog(&window)
        .add_filter("LUT files", &["cube", "lut"])
        .blocking_pick_file();
    Ok(path_opt_to_string(file))
}

#[tauri::command]
pub async fn pick_folder(window: tauri::Window) -> Result<String, PublicBackendError> {
    let folder = file_dialog(&window).blocking_pick_folder();
    Ok(path_opt_to_string(folder))
}

#[tauri::command]
pub async fn pick_ffmpeg_file(window: tauri::Window) -> Result<String, PublicBackendError> {
    let file = executable_file_dialog(&window).blocking_pick_file();
    Ok(path_opt_to_string(file))
}

#[tauri::command]
pub async fn pick_ffprobe_file(window: tauri::Window) -> Result<String, PublicBackendError> {
    let file = executable_file_dialog(&window).blocking_pick_file();
    Ok(path_opt_to_string(file))
}

fn executable_file_dialog<R: tauri::Runtime>(
    window: &tauri::Window<R>,
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    let dialog = file_dialog(window);
    let dialog = match executable_filter_extensions() {
        Some(extensions) => dialog.add_filter("Executable", extensions),
        None => dialog,
    };
    dialog.add_filter("All files", &["*"])
}

fn executable_filter_extensions() -> Option<&'static [&'static str]> {
    #[cfg(windows)]
    {
        Some(&["exe"])
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[tauri::command]
pub async fn pick_import_file(window: tauri::Window) -> Result<String, PublicBackendError> {
    let file = file_dialog(&window)
        .add_filter("JSON profiles", &["json"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    Ok(path_opt_to_string(file))
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SaveFileFormat {
    Json,
    Png,
}

fn save_file_filter(format: Option<SaveFileFormat>) -> (&'static str, &'static [&'static str]) {
    match format.unwrap_or(SaveFileFormat::Json) {
        SaveFileFormat::Json => ("JSON", &["json"]),
        SaveFileFormat::Png => ("PNG image", &["png"]),
    }
}

fn save_file_location(default_name: &str) -> (Option<PathBuf>, String) {
    let path = std::path::Path::new(default_name);
    if path.is_absolute() {
        if let (Some(parent), Some(name)) =
            (path.parent(), path.file_name().and_then(|s| s.to_str()))
        {
            return (Some(parent.to_path_buf()), name.to_owned());
        }
    }
    (None, default_name.to_owned())
}

#[tauri::command]
pub async fn pick_save_file(
    window: tauri::Window,
    default_name: Option<String>,
    format: Option<SaveFileFormat>,
) -> Result<String, PublicBackendError> {
    let mut dialog = file_dialog(&window);
    if let Some(name) = default_name {
        let (directory, name) = save_file_location(&name);
        if let Some(directory) = directory {
            dialog = dialog.set_directory(directory);
        }
        dialog = dialog.set_file_name(name);
    }
    let (label, extensions) = save_file_filter(format);
    let file = dialog.add_filter(label, extensions).blocking_save_file();
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
pub async fn copy_file_to_clipboard(
    window: tauri::Window,
    path: String,
) -> Result<(), PublicBackendError> {
    copy_files(window, vec![path]).await
}

/// Copies several files as one clipboard entry, so they paste together.
#[tauri::command]
pub async fn copy_files_to_clipboard(
    window: tauri::Window,
    paths: Vec<String>,
) -> Result<(), PublicBackendError> {
    copy_files(window, paths).await
}

async fn copy_files(window: tauri::Window, paths: Vec<String>) -> Result<(), PublicBackendError> {
    use crate::platform::file_clipboard::validate_file_paths;
    let paths = tauri::async_runtime::spawn_blocking(move || validate_file_paths(&paths))
        .await
        .map_err(|_| {
            PublicBackendError::new("INTERNAL_ERROR", "Could not check the file to copy.")
        })??;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(crate::platform::file_clipboard::copy_files(&target, &paths));
        })
        .map_err(|_| {
            PublicBackendError::new("INTERNAL_ERROR", "Could not access the clipboard.")
        })?;
    receiver.await.map_err(|_| {
        PublicBackendError::new("INTERNAL_ERROR", "Could not copy the file. Try again.")
    })?
}

fn paste_error() -> PublicBackendError {
    PublicBackendError::new("INTERNAL_ERROR", "Could not read the clipboard. Try again.")
}

// a paste takes what the video and audio pickers offer, so a copied document never reaches the
// Library as a video that can't be read
fn pickable_files(files: Vec<String>) -> Vec<String> {
    files
        .into_iter()
        .filter(|file| {
            std::path::Path::new(file)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    let extension = extension.to_ascii_lowercase();
                    VIDEO_EXTENSIONS.contains(&extension.as_str())
                        || AUDIO_EXTENSIONS.contains(&extension.as_str())
                })
        })
        .collect()
}

/// The existing video and audio files on the clipboard: files copied in a file manager, or
/// absolute paths copied as text. Anything else gives an empty list, since a paste with nothing
/// to add is not an error.
#[tauri::command]
pub async fn read_clipboard_files(
    app: tauri::AppHandle,
) -> Result<Vec<String>, PublicBackendError> {
    let paths = copied_paths(&app).await?;
    tauri::async_runtime::spawn_blocking(move || {
        pickable_files(crate::platform::file_clipboard::existing_files(paths))
    })
    .await
    .map_err(|_| paste_error())
}

#[cfg(windows)]
async fn copied_paths(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, PublicBackendError> {
    use crate::platform::file_clipboard::{paths_from_text, read_copied_files};
    let files = tauri::async_runtime::spawn_blocking(read_copied_files)
        .await
        .map_err(|_| paste_error())??;
    if let Some(files) = files {
        return Ok(files);
    }
    // an empty or non-text clipboard reads as an error here, which only means nothing to add
    Ok(app
        .clipboard()
        .read_text()
        .map(|text| paths_from_text(&text))
        .unwrap_or_default())
}

#[cfg(target_os = "linux")]
async fn copied_paths(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, PublicBackendError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        crate::platform::file_clipboard::read_copied_files(move |paths| {
            let _ = sender.send(paths);
        });
    })
    .map_err(|_| paste_error())?;
    receiver.await.map_err(|_| paste_error())
}

#[cfg(not(any(windows, target_os = "linux")))]
async fn copied_paths(_app: &tauri::AppHandle) -> Result<Vec<PathBuf>, PublicBackendError> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn open_output_folder(path: String) -> Result<(), PublicBackendError> {
    tauri::async_runtime::spawn_blocking(move || open_with_validation(&path, &SystemOpener))
        .await
        .map_err(|_| {
            PublicBackendError::new("INTERNAL_ERROR", "Could not show the export in its folder.")
        })?
}

/// The file of an export the backend's queue has finished. The page names the export by its
/// queue id, never by path, so these commands can't be pointed at any other file.
fn completed_export_path(queue: &Value, item_id: &str) -> Result<PathBuf, PublicBackendError> {
    if item_id.is_empty() || item_id.len() > 128 {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Choose a finished export.",
        ));
    }
    let item = queue
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(item_id))
        })
        .ok_or_else(|| {
            PublicBackendError::new(
                "INVALID_REQUEST",
                "This export is no longer in the list. Export the video again to open it.",
            )
        })?;
    if item.get("state").and_then(Value::as_str) != Some("completed") {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "This export isn't finished yet.",
        ));
    }
    let raw_path = item
        .get("result_path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let path = PathBuf::from(raw_path);
    let media = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| {
            VIDEO_EXTENSIONS.contains(&extension.as_str())
                || AUDIO_EXTENSIONS.contains(&extension.as_str())
        });
    // the file opens in whatever app handles its type, so only media files qualify
    if raw_path.trim().is_empty() || raw_path.contains('\0') || !path.is_absolute() || !media {
        return Err(PublicBackendError::new(
            "MALFORMED_BACKEND_OUTPUT",
            "The backend returned an invalid export location.",
        ));
    }
    if !std::fs::metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
        return Err(PublicBackendError::new(
            "INVALID_PATH",
            "The export could not be found. It may have been moved or deleted.",
        ));
    }
    Ok(path)
}

fn check_export_count(item_ids: &[String]) -> Result<(), PublicBackendError> {
    use crate::platform::file_clipboard::MAX_FILES;
    if item_ids.is_empty() {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Choose the exports to drag.",
        ));
    }
    if item_ids.len() > MAX_FILES {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            format!("Drag up to {MAX_FILES} exports at a time."),
        ));
    }
    Ok(())
}

/// The files of several finished exports, each once and in the order given. One export that
/// can't be used fails the whole list.
fn completed_export_paths(
    queue: &Value,
    item_ids: &[String],
) -> Result<Vec<PathBuf>, PublicBackendError> {
    check_export_count(item_ids)?;
    let mut paths: Vec<PathBuf> = Vec::with_capacity(item_ids.len());
    for item_id in item_ids {
        let path = completed_export_path(queue, item_id)?;
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

async fn finished_export(
    state: &BackendState,
    item_id: String,
) -> Result<PathBuf, PublicBackendError> {
    let queue = state.request(BackendCommand::GetQueueState).await?;
    tauri::async_runtime::spawn_blocking(move || completed_export_path(&queue, &item_id))
        .await
        .map_err(|_| PublicBackendError::new("INTERNAL_ERROR", "Could not find the export."))?
}

#[tauri::command]
pub async fn open_export_file(
    state: tauri::State<'_, BackendState>,
    item_id: String,
) -> Result<(), PublicBackendError> {
    let path = finished_export(&state, item_id).await?;
    tauri::async_runtime::spawn_blocking(move || launch_export(&path, &SystemOpener))
        .await
        .map_err(|_| PublicBackendError::new("INTERNAL_ERROR", "Could not open the export."))?
}

/// Starts dragging a finished export out of the window as a file. Returns false when the button
/// was let go before the drag could start, so nothing was dragged.
#[tauri::command]
pub async fn start_export_drag(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BackendState>,
    item_id: String,
) -> Result<bool, PublicBackendError> {
    drag_exports(window, &state, vec![item_id]).await
}

/// Starts one drag carrying several finished exports, like `start_export_drag`.
#[tauri::command]
pub async fn start_exports_drag(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BackendState>,
    item_ids: Vec<String>,
) -> Result<bool, PublicBackendError> {
    drag_exports(window, &state, item_ids).await
}

async fn drag_exports(
    window: tauri::WebviewWindow,
    state: &BackendState,
    item_ids: Vec<String>,
) -> Result<bool, PublicBackendError> {
    // a bad list fails before waiting on the backend's queue
    check_export_count(&item_ids)?;
    let queue = state.request(BackendCommand::GetQueueState).await?;
    let paths =
        tauri::async_runtime::spawn_blocking(move || completed_export_paths(&queue, &item_ids))
            .await
            .map_err(|_| {
                PublicBackendError::new("INTERNAL_ERROR", "Could not find the export.")
            })??;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .with_webview(move |webview| {
            let _ = sender.send(file_drag::start(&target, &webview, &paths));
        })
        .map_err(|_| PublicBackendError::new("INTERNAL_ERROR", "Could not drag the export."))?;
    receiver
        .await
        .map_err(|_| PublicBackendError::new("INTERNAL_ERROR", "Could not drag the export."))?
}

#[tauri::command]
pub async fn open_local_document(
    app: tauri::AppHandle,
    document: LocalDocument,
) -> Result<(), PublicBackendError> {
    let resources = app.path().resource_dir().map_err(|_| {
        PublicBackendError::new("DOCUMENT_UNAVAILABLE", "Could not find Tuck's documents.")
    })?;
    #[cfg(debug_assertions)]
    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    let source_root: Option<PathBuf> = None;
    tauri::async_runtime::spawn_blocking(move || {
        open_document_with(
            document,
            &resources,
            source_root.as_deref(),
            open_document_file,
        )
    })
    .await
    .map_err(|_| PublicBackendError::new("INTERNAL_ERROR", "Could not open this document."))?
}

#[tauri::command]
pub async fn open_logs_folder(
    state: tauri::State<'_, BackendState>,
) -> Result<(), PublicBackendError> {
    open_storage_folder(&state, StorageFolder::Logs).await
}

#[tauri::command]
pub async fn open_config_folder(
    state: tauri::State<'_, BackendState>,
) -> Result<(), PublicBackendError> {
    open_storage_folder(&state, StorageFolder::Config).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoragePaths {
    config_dir: String,
    data_dir: String,
    cache_dir: String,
    log_dir: String,
}

enum StorageFolder {
    Config,
    Logs,
}

async fn open_storage_folder(
    state: &BackendState,
    folder: StorageFolder,
) -> Result<(), PublicBackendError> {
    let paths = state.request(BackendCommand::GetStoragePaths).await?;
    let path = storage_folder(paths, folder)?;
    tauri::async_runtime::spawn_blocking(move || {
        open_app_folder_with_validation(&path, &SystemOpener)
    })
    .await
    .map_err(|_| PublicBackendError::new("INTERNAL_ERROR", "Could not open folder."))?
}

fn storage_folder(value: Value, folder: StorageFolder) -> Result<PathBuf, PublicBackendError> {
    let paths: StoragePaths = serde_json::from_value(value).map_err(|_| {
        PublicBackendError::new(
            "MALFORMED_BACKEND_OUTPUT",
            "The backend returned invalid storage locations.",
        )
    })?;
    let config_dir = validate_storage_path(&paths.config_dir)?;
    let _data_dir = validate_storage_path(&paths.data_dir)?;
    let _cache_dir = validate_storage_path(&paths.cache_dir)?;
    let log_dir = validate_storage_path(&paths.log_dir)?;
    Ok(match folder {
        StorageFolder::Config => config_dir,
        StorageFolder::Logs => log_dir,
    })
}

fn validate_storage_path(raw_path: &str) -> Result<PathBuf, PublicBackendError> {
    if raw_path.trim().is_empty() || raw_path.contains('\0') {
        return Err(PublicBackendError::new(
            "MALFORMED_BACKEND_OUTPUT",
            "The backend returned an invalid storage location.",
        ));
    }
    let path = PathBuf::from(raw_path);
    if !path.is_absolute() {
        return Err(PublicBackendError::new(
            "MALFORMED_BACKEND_OUTPUT",
            "The backend returned a relative storage location.",
        ));
    }
    Ok(path)
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
    fn frame_save_dialog_starts_in_the_source_directory() {
        let directory = std::env::temp_dir().join("Tuck videos");
        let output = directory.join("Recording-frame-00-00-03-250.png");
        assert_eq!(
            save_file_location(output.to_str().unwrap()),
            (Some(directory), "Recording-frame-00-00-03-250.png".into())
        );
        assert_eq!(
            save_file_location("profiles.json"),
            (None, "profiles.json".into())
        );
    }

    #[cfg(windows)]
    #[test]
    fn frame_save_dialog_keeps_unc_and_unicode_directories() {
        assert_eq!(
            save_file_location(r"\\server\videos\żółć\frame.png"),
            (
                Some(PathBuf::from(r"\\server\videos\żółć")),
                "frame.png".into()
            )
        );
    }

    #[test]
    fn a_paste_takes_only_what_the_video_and_audio_pickers_offer() {
        let files = [
            r"X:\clips\Match.MP4",
            r"X:\clips\take.mkv",
            r"X:\clips\music.flac",
            r"X:\clips\notes.txt",
            r"X:\clips\cover.png",
            r"X:\clips\no extension",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            pickable_files(files),
            [
                r"X:\clips\Match.MP4",
                r"X:\clips\take.mkv",
                r"X:\clips\music.flac"
            ]
        );
    }

    #[test]
    fn save_file_filters_preserve_profiles_and_allow_png_frames() {
        assert_eq!(save_file_filter(None), ("JSON", &["json"][..]));
        assert_eq!(
            save_file_filter(Some(SaveFileFormat::Json)),
            ("JSON", &["json"][..])
        );
        assert_eq!(
            save_file_filter(Some(SaveFileFormat::Png)),
            ("PNG image", &["png"][..])
        );
        assert!(serde_json::from_value::<SaveFileFormat>(serde_json::json!("exe")).is_err());
    }

    struct ExportFile(PathBuf);

    impl ExportFile {
        fn new(name: &str) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "tuck-export-result-{}-{}",
                std::process::id(),
                name.replace(['#', ',', ' '], "-")
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let file = directory.join(name);
            std::fs::write(&file, b"export bytes").unwrap();
            Self(file)
        }

        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }

    impl Drop for ExportFile {
        fn drop(&mut self) {
            if let Some(directory) = self.0.parent() {
                let _ = std::fs::remove_dir_all(directory);
            }
        }
    }

    fn queue(items: Value) -> Value {
        serde_json::json!({ "items": items, "current_id": null, "pending_ids": [] })
    }

    #[test]
    fn a_finished_export_resolves_to_its_own_file() {
        let file = ExportFile::new("Clip #1, final_small.MP4");
        let snapshot = queue(serde_json::json!([
            { "id": "other", "state": "completed", "result_path": "/elsewhere/other.mp4" },
            { "id": "done", "state": "completed", "result_path": file.path() },
        ]));
        assert_eq!(completed_export_path(&snapshot, "done").unwrap(), file.0);
    }

    #[test]
    fn only_a_finished_export_the_queue_knows_can_be_opened() {
        let file = ExportFile::new("states.mp4");
        for (state, id) in [
            ("running", "item"),
            ("pending", "item"),
            ("failed", "item"),
            ("cancelled", "item"),
            ("completed", "unknown"),
            ("completed", ""),
        ] {
            let snapshot = queue(serde_json::json!([
                { "id": "item", "state": state, "result_path": file.path() },
            ]));
            assert_eq!(
                completed_export_path(&snapshot, id).unwrap_err().code,
                "INVALID_REQUEST",
                "{state} {id:?}"
            );
        }
        let long_id = "x".repeat(129);
        let snapshot = queue(serde_json::json!([
            { "id": long_id, "state": "completed", "result_path": file.path() },
        ]));
        assert_eq!(
            completed_export_path(&snapshot, &long_id).unwrap_err().code,
            "INVALID_REQUEST"
        );
        assert_eq!(
            completed_export_path(&serde_json::json!({}), "item")
                .unwrap_err()
                .code,
            "INVALID_REQUEST"
        );
    }

    #[test]
    fn an_export_path_that_is_not_a_media_file_is_never_opened() {
        let program = ExportFile::new("setup.exe");
        let script = ExportFile::new("run.sh");
        let no_extension = ExportFile::new("video");
        for raw in [
            program.path().to_owned(),
            script.path().to_owned(),
            no_extension.path().to_owned(),
            "relative/clip.mp4".to_owned(),
            String::new(),
            "/tmp/clip\0.mp4".to_owned(),
        ] {
            let snapshot = queue(serde_json::json!([
                { "id": "item", "state": "completed", "result_path": raw },
            ]));
            assert_eq!(
                completed_export_path(&snapshot, "item").unwrap_err().code,
                "MALFORMED_BACKEND_OUTPUT",
                "{raw:?}"
            );
        }
        let snapshot = queue(serde_json::json!([{ "id": "item", "state": "completed" }]));
        assert_eq!(
            completed_export_path(&snapshot, "item").unwrap_err().code,
            "MALFORMED_BACKEND_OUTPUT"
        );
    }

    #[test]
    fn a_moved_or_deleted_export_says_so() {
        let file = ExportFile::new("moved.mkv");
        let missing = file.0.with_file_name("gone.mkv");
        let folder = file.0.with_file_name("folder.mp4");
        std::fs::create_dir_all(&folder).unwrap();
        for path in [missing, folder] {
            let snapshot = queue(serde_json::json!([
                { "id": "item", "state": "completed", "result_path": path },
            ]));
            assert_eq!(
                completed_export_path(&snapshot, "item").unwrap_err().code,
                "INVALID_PATH"
            );
        }
    }

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn several_finished_exports_resolve_once_each_in_order() {
        let first = ExportFile::new("first take.mp4");
        let second = ExportFile::new("Zażółć #2.mkv");
        let third = ExportFile::new("third.mov");
        let snapshot = queue(serde_json::json!([
            { "id": "a", "state": "completed", "result_path": first.path() },
            { "id": "b", "state": "completed", "result_path": second.path() },
            { "id": "c", "state": "completed", "result_path": third.path() },
            // two rows that name one file still drag it once
            { "id": "c-again", "state": "completed", "result_path": third.path() },
        ]));
        assert_eq!(
            completed_export_paths(&snapshot, &ids(&["c", "a", "c", "b", "c-again"])).unwrap(),
            [third.0.clone(), first.0.clone(), second.0.clone()]
        );
        assert_eq!(
            completed_export_paths(&snapshot, &ids(&["b"])).unwrap(),
            std::slice::from_ref(&second.0)
        );
    }

    #[test]
    fn one_export_that_cant_be_dragged_fails_the_whole_drag() {
        let done = ExportFile::new("done.mp4");
        let missing = done.0.with_file_name("gone.mp4");
        let snapshot = queue(serde_json::json!([
            { "id": "done", "state": "completed", "result_path": done.path() },
            { "id": "running", "state": "running", "result_path": done.path() },
            { "id": "moved", "state": "completed", "result_path": missing },
        ]));
        for (other, code, message) in [
            (
                "running",
                "INVALID_REQUEST",
                "This export isn't finished yet.",
            ),
            (
                "unknown",
                "INVALID_REQUEST",
                "This export is no longer in the list. Export the video again to open it.",
            ),
            ("", "INVALID_REQUEST", "Choose a finished export."),
            (
                "moved",
                "INVALID_PATH",
                "The export could not be found. It may have been moved or deleted.",
            ),
        ] {
            for list in [ids(&["done", other]), ids(&[other, "done"])] {
                let error = completed_export_paths(&snapshot, &list).unwrap_err();
                assert_eq!(
                    (error.code.as_str(), error.message.as_str()),
                    (code, message),
                    "{list:?}"
                );
            }
        }
    }

    #[test]
    fn an_export_drag_takes_one_to_a_hundred_exports() {
        let empty = check_export_count(&[]).unwrap_err();
        assert_eq!(
            (empty.code.as_str(), empty.message.as_str()),
            ("INVALID_REQUEST", "Choose the exports to drag.")
        );
        assert!(check_export_count(&ids(&["one"])).is_ok());
        assert!(check_export_count(&vec!["item".to_owned(); 100]).is_ok());
        let too_many = check_export_count(&vec!["item".to_owned(); 101]).unwrap_err();
        assert_eq!(
            (too_many.code.as_str(), too_many.message.as_str()),
            ("INVALID_REQUEST", "Drag up to 100 exports at a time.")
        );
        // resolving the exports keeps the same limit
        let file = ExportFile::new("limit.mp4");
        let snapshot = queue(serde_json::json!([
            { "id": "item", "state": "completed", "result_path": file.path() },
        ]));
        assert_eq!(
            completed_export_paths(&snapshot, &vec!["item".to_owned(); 101])
                .unwrap_err()
                .message,
            "Drag up to 100 exports at a time."
        );
        assert_eq!(
            completed_export_paths(&snapshot, &vec!["item".to_owned(); 100]).unwrap(),
            std::slice::from_ref(&file.0)
        );
    }

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

    #[test]
    fn executable_filters_are_windows_only() {
        #[cfg(windows)]
        assert_eq!(executable_filter_extensions(), Some(&["exe"][..]));
        #[cfg(not(windows))]
        assert_eq!(executable_filter_extensions(), None);
    }

    #[test]
    fn storage_folders_use_the_sidecars_authoritative_paths() {
        #[cfg(windows)]
        let paths = serde_json::json!({
            "config_dir": "C:\\Users\\Tuck\\config",
            "data_dir": "C:\\Users\\Tuck\\data",
            "cache_dir": "C:\\Users\\Tuck\\cache",
            "log_dir": "C:\\Users\\Tuck\\data\\logs",
        });
        #[cfg(not(windows))]
        let paths = serde_json::json!({
            "config_dir": "/home/tuck/.config",
            "data_dir": "/home/tuck/.local/share",
            "cache_dir": "/home/tuck/.cache",
            "log_dir": "/home/tuck/.local/share/logs",
        });

        #[cfg(windows)]
        let expected_config = PathBuf::from("C:\\Users\\Tuck\\config");
        #[cfg(not(windows))]
        let expected_config = PathBuf::from("/home/tuck/.config");
        #[cfg(windows)]
        let expected_logs = PathBuf::from("C:\\Users\\Tuck\\data\\logs");
        #[cfg(not(windows))]
        let expected_logs = PathBuf::from("/home/tuck/.local/share/logs");

        assert_eq!(
            storage_folder(paths.clone(), StorageFolder::Config).unwrap(),
            expected_config
        );
        assert_eq!(
            storage_folder(paths, StorageFolder::Logs).unwrap(),
            expected_logs
        );
    }

    #[test]
    fn storage_folder_rejects_malformed_or_relative_backend_paths() {
        let malformed = serde_json::json!({ "config_dir": "C:\\config" });
        assert_eq!(
            storage_folder(malformed, StorageFolder::Config)
                .expect_err("all sidecar storage paths are required")
                .code,
            "MALFORMED_BACKEND_OUTPUT"
        );

        let relative = serde_json::json!({
            "config_dir": "config",
            "data_dir": "data",
            "cache_dir": "cache",
            "log_dir": "logs",
        });
        assert_eq!(
            storage_folder(relative, StorageFolder::Config)
                .expect_err("storage folders must be absolute")
                .code,
            "MALFORMED_BACKEND_OUTPUT"
        );
    }
}
