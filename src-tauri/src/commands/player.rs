use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::backend::protocol::PublicBackendError;
use crate::platform::window_chrome::css_to_physical;
use crate::player::engine::{
    Edits, LutUpdate, Mix, PlayerCommand, PlayerError, PlayerState, PlayerStatus, LUT_SIZES,
};
use crate::player::{library, preview_mode, PreviewMode, Viewport};

fn surface_error(message: &str) -> PublicBackendError {
    PublicBackendError::new("PREVIEW_SURFACE_FAILED", message)
}

fn not_turned_on() -> PublicBackendError {
    PublicBackendError::new("NOT_AVAILABLE", "The native preview is not turned on.")
}

// the page cannot turn the surface on by itself; only this run's switch can
fn require_surface_mode() -> Result<(), PublicBackendError> {
    match preview_mode() {
        PreviewMode::Surface | PreviewMode::Engine | PreviewMode::Player => Ok(()),
        PreviewMode::Off => Err(not_turned_on()),
    }
}

fn require_engine_mode() -> Result<(), PublicBackendError> {
    match preview_mode() {
        PreviewMode::Engine | PreviewMode::Player => Ok(()),
        PreviewMode::Off | PreviewMode::Surface => Err(not_turned_on()),
    }
}

fn player_error(error: PlayerError) -> PublicBackendError {
    match error {
        PlayerError::NotOpen => PublicBackendError::new("PLAYER_NOT_OPEN", "No video is open."),
        PlayerError::InvalidLength => {
            PublicBackendError::new("INVALID_REQUEST", "The video length is not valid.")
        }
        PlayerError::SeekRefused => PublicBackendError::new(
            "SEEK_REFUSED",
            "The seek was older than the last one or outside the video.",
        ),
        PlayerError::InvalidVolume => {
            PublicBackendError::new("INVALID_REQUEST", "The volume must be between 0 and 1.")
        }
        PlayerError::InvalidRate => PublicBackendError::new(
            "INVALID_REQUEST",
            "The playback speed must be between 0.25 and 4.",
        ),
        PlayerError::InvalidMix => {
            PublicBackendError::new("INVALID_REQUEST", "The preview mix is not valid.")
        }
        PlayerError::InvalidEdits => {
            PublicBackendError::new("INVALID_REQUEST", "The timeline is not valid.")
        }
        PlayerError::InvalidLut => {
            PublicBackendError::new("INVALID_REQUEST", "The LUT preview data is invalid.")
        }
        PlayerError::Video(message) => PublicBackendError::new("VIDEO_FAILED", message),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest {
    duration_seconds: f64,
    /// the video file; the bare clock ignores it, the native player library needs it
    path: Option<String>,
}

/// Starts the player for the selected video, replacing the previous one.
#[tauri::command]
pub async fn player_open(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PlayerState>,
    request: OpenRequest,
) -> Result<PlayerStatus, PublicBackendError> {
    require_engine_mode()?;
    if preview_mode() == PreviewMode::Engine {
        return state.open(request.duration_seconds).map_err(player_error);
    }
    let path = video_path(request.path)?;
    // the page may ask for the video before it asked for the surface; either order works
    show_surface(&window).await?;
    let target = preview_target()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.open_video(
            request.duration_seconds,
            &path,
            target.window as *mut std::ffi::c_void,
            target.display_interval,
            target.download_frames,
        )
    })
    .await
    .map_err(|_| PublicBackendError::new("VIDEO_FAILED", "The video could not be opened."))?
    .map_err(player_error)
}

// the page names the file; only an existing regular file is ever handed to the decoder
fn video_path(path: Option<String>) -> Result<PathBuf, PublicBackendError> {
    let invalid = || PublicBackendError::new("INVALID_REQUEST", "The video file is not available.");
    let path = PathBuf::from(path.ok_or_else(invalid)?);
    if !path.is_absolute() || !path.is_file() {
        return Err(invalid());
    }
    Ok(path)
}

/// Where and how the library draws the video.
struct PreviewTarget {
    window: isize,
    /// seconds between display refreshes, or 0 to let the library ask the system
    display_interval: f64,
    download_frames: bool,
}

#[cfg(windows)]
fn preview_target() -> Result<PreviewTarget, PublicBackendError> {
    let window = crate::player::surface_windows::window()
        .ok_or_else(|| surface_error("The preview is not ready yet."))?;
    // the library asks Windows about the display the window is on
    Ok(PreviewTarget {
        window,
        display_interval: 0.0,
        download_frames: false,
    })
}

// on Linux the surface's GL area draws, so the library gets no window
#[cfg(target_os = "linux")]
fn preview_target() -> Result<PreviewTarget, PublicBackendError> {
    use crate::player::surface_linux;
    let display_interval = surface_linux::refresh_interval()
        .ok_or_else(|| surface_error("The preview is not ready yet."))?;
    Ok(PreviewTarget {
        window: 0,
        display_interval,
        download_frames: !surface_linux::imports_frames(),
    })
}

/// The timeline's length and which footage each segment shows, for the open video.
#[tauri::command]
pub fn player_edits(
    state: tauri::State<'_, PlayerState>,
    edits: Edits,
) -> Result<PlayerStatus, PublicBackendError> {
    require_engine_mode()?;
    state.set_edits(&edits).map_err(player_error)
}

/// The preview mix Python compiled for the open video. Every sound in it must be an existing
/// file, as the video is, before the library reads it.
#[tauri::command]
pub fn player_mix(
    state: tauri::State<'_, PlayerState>,
    mix: Mix,
) -> Result<(), PublicBackendError> {
    require_engine_mode()?;
    for voice in &mix.voices {
        video_path(Some(voice.path.clone()))?;
    }
    state.set_mix(&mix).map_err(player_error)
}

/// Plays, pauses or seeks, and returns the status right after.
#[tauri::command]
pub fn player_command(
    state: tauri::State<'_, PlayerState>,
    command: PlayerCommand,
) -> Result<PlayerStatus, PublicBackendError> {
    require_engine_mode()?;
    state.command(command).map_err(player_error)
}

/// The page's LUT as it sends it: the size, strength and comparison split in headers, the table as
/// raw little-endian floats, so a 65³ table doesn't travel as megabytes of JSON. An empty body with
/// a size keeps the table and changes only the strength and split; size 0 removes the LUT. Without
/// a split the LUT covers the whole picture.
fn parse_lut(
    size: Option<&str>,
    strength: Option<&str>,
    split: Option<&str>,
    body: &[u8],
) -> Option<LutUpdate> {
    let size: i32 = size?.trim().parse().ok()?;
    let strength: f64 = strength?.trim().parse().ok()?;
    let split = match split {
        Some(value) => Some(value.trim().parse::<f64>().ok()?),
        None => None,
    };
    let table = if size == 0 {
        Some(None)
    } else if !LUT_SIZES.contains(&size) {
        return None;
    } else if body.is_empty() {
        None
    } else {
        let (floats, partial) = body.as_chunks::<4>();
        if !partial.is_empty() {
            return None;
        }
        Some(Some((
            floats
                .iter()
                .map(|bytes| f32::from_le_bytes(*bytes))
                .collect(),
            size,
        )))
    };
    Some(LutUpdate {
        table,
        strength,
        split,
    })
}

/// Shows the export's LUT in the native preview, for this video and the ones opened after it.
#[tauri::command]
pub fn player_lut(
    state: tauri::State<'_, PlayerState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), PublicBackendError> {
    require_engine_mode()?;
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => &bytes[..],
        tauri::ipc::InvokeBody::Json(_) => &[],
    };
    let update = parse_lut(
        header("x-lut-size"),
        header("x-lut-strength"),
        header("x-lut-split"),
        body,
    )
    .ok_or_else(|| player_error(PlayerError::InvalidLut))?;
    state.set_lut(update).map_err(player_error)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryReport {
    loaded: bool,
    /// the interface version this Tuck expects
    interface: i32,
    error: String,
}

/// The preview as the diagnostic report describes it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerReport {
    mode: &'static str,
    /// only when this run decodes with the native player library
    library: Option<LibraryReport>,
    /// the open video's status, when the native engine has one
    status: Option<PlayerStatus>,
}

/// What the diagnostic report says about the preview. It never fails, so the report can always be
/// made, and it works with the native preview off.
#[tauri::command]
pub fn player_report(state: tauri::State<'_, PlayerState>) -> PlayerReport {
    build_report(preview_mode(), state.inner(), library::check)
}

fn build_report(
    mode: PreviewMode,
    state: &PlayerState,
    check_library: impl FnOnce() -> Result<(), String>,
) -> PlayerReport {
    let library = (mode == PreviewMode::Player).then(|| {
        let result = check_library();
        LibraryReport {
            loaded: result.is_ok(),
            interface: library::ABI,
            error: result.err().unwrap_or_default(),
        }
    });
    let status = match mode {
        PreviewMode::Engine | PreviewMode::Player => state.status().ok(),
        PreviewMode::Off | PreviewMode::Surface => None,
    };
    PlayerReport {
        mode: mode.as_str(),
        library,
        status,
    }
}

#[tauri::command]
pub fn player_status(
    state: tauri::State<'_, PlayerState>,
) -> Result<PlayerStatus, PublicBackendError> {
    require_engine_mode()?;
    state.status().map_err(player_error)
}

/// Creates the surface below the page and makes the page's background transparent.
#[tauri::command]
pub async fn preview_surface_open(window: tauri::WebviewWindow) -> Result<(), PublicBackendError> {
    require_surface_mode()?;
    show_surface(&window).await
}

async fn show_surface(window: &tauri::WebviewWindow) -> Result<(), PublicBackendError> {
    window
        .set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)))
        .map_err(|_| surface_error("Could not make the page background transparent."))?;
    open_surface(window).await
}

/// Moves the picture to where the page's hole is, in CSS pixels.
#[tauri::command]
pub fn preview_surface_viewport(
    window: tauri::WebviewWindow,
    viewport: Viewport,
) -> Result<(), PublicBackendError> {
    require_surface_mode()?;
    let viewport = viewport
        .validate()
        .map_err(|message| PublicBackendError::new("INVALID_REQUEST", message))?;
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .run_on_main_thread(move || set_viewport(viewport, scale))
        .map_err(|_| surface_error("Could not move the preview."))
}

#[cfg(windows)]
async fn open_surface(window: &tauri::WebviewWindow) -> Result<(), PublicBackendError> {
    let parent = window
        .hwnd()
        .map_err(|_| surface_error("The window is not ready."))?;
    // HWND is not Send; its raw value crosses to the main thread, which owns the window
    let raw = parent.0 as isize;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let parent = windows::Win32::Foundation::HWND(raw as *mut _);
            // the native player library draws into the window itself
            let test_picture = preview_mode() != PreviewMode::Player;
            let opened = crate::player::surface_windows::open(parent, test_picture);
            let _ = sender.send(opened.is_ok());
        })
        .map_err(|_| surface_error("Could not create the preview."))?;
    match receiver.await {
        Ok(true) => Ok(()),
        _ => Err(surface_error("Could not create the preview.")),
    }
}

#[cfg(target_os = "linux")]
async fn open_surface(window: &tauri::WebviewWindow) -> Result<(), PublicBackendError> {
    use tauri::Manager;
    // the GL area draws the player's frames; the test picture needs no player
    let player = (preview_mode() == PreviewMode::Player)
        .then(|| window.state::<PlayerState>().inner().clone());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let result = crate::player::surface_linux::open(&webview.inner(), player);
            if let Err(message) = result {
                eprintln!("could not create the preview surface: {message}");
            }
            let _ = sender.send(result.is_ok());
        })
        .map_err(|_| surface_error("Could not create the preview."))?;
    match receiver.await {
        Ok(true) => Ok(()),
        _ => Err(surface_error("Could not create the preview.")),
    }
}

#[cfg(windows)]
fn set_viewport(viewport: Viewport, scale: f64) {
    crate::player::surface_windows::set_viewport(viewport, css_to_physical(scale));
}

// GTK positions are logical pixels; it applies the display scale itself
#[cfg(target_os = "linux")]
fn set_viewport(viewport: Viewport, _scale: f64) {
    crate::player::surface_linux::set_viewport(viewport, css_to_physical(1.0));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_says_how_the_preview_plays_and_why_the_library_failed() {
        let state = PlayerState::default();
        let off = build_report(PreviewMode::Off, &state, || unreachable!());
        assert_eq!(
            (off.mode, off.library.is_none(), off.status.is_none()),
            ("off", true, true)
        );

        let missing = build_report(PreviewMode::Player, &state, || {
            Err("The native player library is missing.".to_string())
        });
        let library = missing.library.expect("the player reports its library");
        assert!(!library.loaded);
        assert_eq!(library.interface, library::ABI);
        assert_eq!(library.error, "The native player library is missing.");
        assert!(missing.status.is_none(), "no video is open yet");

        state.open(12.0).expect("the bare clock opens");
        let open = build_report(PreviewMode::Engine, &state, || unreachable!());
        assert!(open.library.is_none(), "the bare clock uses no library");
        assert_eq!(open.status.expect("an open video").duration_seconds, 12.0);
    }

    #[test]
    fn the_lut_arrives_as_headers_and_raw_floats() {
        let floats = |values: &[f32]| {
            values
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>()
        };
        let table = floats(&[0.25; 24]);
        let update = parse_lut(Some("2"), Some("0.5"), None, &table).expect("a table");
        assert_eq!(update.strength, 0.5);
        assert_eq!(update.table, Some(Some((vec![0.25; 24], 2))));
        assert_eq!(
            update.split, None,
            "without a split the LUT covers the picture"
        );
        assert_eq!(
            parse_lut(Some("2"), Some("0.8"), None, &[]).map(|update| update.table),
            Some(None),
            "an empty body keeps the table"
        );
        assert_eq!(
            parse_lut(Some("0"), Some("1"), None, &[]).map(|update| update.table),
            Some(Some(None)),
            "size 0 removes the LUT"
        );
        assert!(parse_lut(None, Some("1"), None, &table).is_none());
        assert!(parse_lut(Some("2"), None, None, &table).is_none());
        assert!(parse_lut(Some("two"), Some("1"), None, &table).is_none());
        assert!(parse_lut(Some("66"), Some("1"), None, &table).is_none());
        assert!(
            parse_lut(Some("2"), Some("1"), None, &table[..95]).is_none(),
            "a partial float is refused"
        );
    }

    #[test]
    fn comparing_moves_only_the_split_and_keeps_the_table() {
        let update = parse_lut(Some("2"), Some("1"), Some("0.35"), &[]).expect("a split");
        assert_eq!(update.split, Some(0.35));
        assert_eq!(update.table, None, "the table stays as it was");
        assert!(
            parse_lut(Some("2"), Some("1"), Some("half"), &[]).is_none(),
            "a split that isn't a number is refused"
        );
        // the range itself is the engine's to check, with the strength's
        let wide = parse_lut(Some("2"), Some("1"), Some("1.5"), &[]).expect("parsed");
        assert_eq!(
            PlayerState::default().set_lut(wide),
            Err(PlayerError::InvalidLut)
        );
    }

    #[test]
    fn only_an_existing_file_reaches_the_decoder() {
        let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
        assert!(video_path(Some(manifest.to_string())).is_ok());
        assert!(video_path(None).is_err());
        assert!(video_path(Some("Cargo.toml".to_string())).is_err());
        assert!(video_path(Some(env!("CARGO_MANIFEST_DIR").to_string())).is_err());
        let missing = concat!(env!("CARGO_MANIFEST_DIR"), "/no-such-video.mp4");
        assert!(video_path(Some(missing.to_string())).is_err());
    }

    #[test]
    fn open_requests_parse_strictly() {
        let parse = |json: &str| serde_json::from_str::<OpenRequest>(json);
        assert!(parse(r#"{"durationSeconds":12,"path":null}"#).is_ok());
        assert!(parse(r#"{"durationSeconds":12,"path":"C:/v.mp4"}"#).is_ok());
        assert!(parse(r#"{"path":"C:/v.mp4"}"#).is_err());
        assert!(parse(r#"{"durationSeconds":12,"path":null,"window":1}"#).is_err());
    }
}
