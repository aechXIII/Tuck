use std::sync::{Mutex, PoisonError};

use serde::Deserialize;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{LogicalSize, UserAttentionType};
use tauri_plugin_notification::NotificationExt;

use crate::backend::protocol::PublicBackendError;

/// The layout is designed for at least this many CSS pixels.
pub(crate) const MIN_LAYOUT_WIDTH: f64 = 960.0;
pub(crate) const MIN_LAYOUT_HEIGHT: f64 = 640.0;

// the minimum tauri.conf.json gives the main window, until one is set here
static WINDOW_MIN_SIZE: Mutex<(f64, f64)> = Mutex::new((MIN_LAYOUT_WIDTH, MIN_LAYOUT_HEIGHT));

const MAX_NOTIFICATION_TITLE: usize = 120;
const MAX_NOTIFICATION_BODY: usize = 400;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceSize {
    Compact,
    Default,
    Large,
}

impl InterfaceSize {
    pub fn zoom(self) -> f64 {
        1.0
    }

    /// The smallest window, in logical pixels, that still gives the page its minimum layout.
    pub fn min_window_size(self) -> (f64, f64) {
        (MIN_LAYOUT_WIDTH, MIN_LAYOUT_HEIGHT)
    }
}

/// Clears page zoom from older density settings and preserves the supported layout size.
#[tauri::command]
pub fn set_interface_size(
    window: tauri::WebviewWindow,
    size: InterfaceSize,
) -> Result<(), PublicBackendError> {
    let failed =
        |_| PublicBackendError::new("INTERNAL_ERROR", "Could not change the interface size.");
    keep_minimum_size(&window, size).map_err(failed)?;
    window.set_zoom(size.zoom()).map_err(failed)?;
    crate::platform::window_chrome::set_page_zoom(size.zoom());
    place_caption_overlay(&window);
    Ok(())
}

/// Keeps the window at least as large as the page's minimum layout. Also called as the window
/// is set up, since the page only asks again when the interface size isn't the default.
pub(crate) fn keep_minimum_size(
    window: &tauri::WebviewWindow,
    size: InterfaceSize,
) -> tauri::Result<()> {
    let scale = window.scale_factor()?;
    let (mut min_width, mut min_height) = size.min_window_size();
    let frame = minimum_frame(window, scale);
    let (mut outer_width, mut outer_height) = (min_width + frame.0, min_height + frame.1);
    // keep the minimum within the current screen's usable area
    if let Ok(Some(monitor)) = window.current_monitor() {
        let screen = monitor
            .work_area()
            .size
            .to_logical::<f64>(monitor.scale_factor());
        min_width = min_width.min(screen.width);
        min_height = min_height.min(screen.height);
        outer_width = outer_width.min(screen.width);
        outer_height = outer_height.min(screen.height);
    }
    let normal = !window.is_maximized().unwrap_or(false)
        && !window.is_fullscreen().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false);
    // Windows applies a new minimum by setting the size again, which also restores a maximized
    // window, so the minimum only changes when it differs and the window is at its normal size
    let mut applied = WINDOW_MIN_SIZE
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if normal && *applied != (outer_width, outer_height) {
        window.set_min_size(Some(LogicalSize::new(outer_width, outer_height)))?;
        *applied = (outer_width, outer_height);
    }
    drop(applied);
    let current = window.inner_size()?.to_logical::<f64>(scale);
    if normal && (current.width < min_width || current.height < min_height) {
        window.set_size(LogicalSize::new(
            current.width.max(min_width),
            current.height.max(min_height),
        ))?;
    }
    Ok(())
}

// tao gives a window without decorations its minimum as the outer size, but Windows keeps the
// resize borders around the page, so they are added back to keep the page at its minimum
#[cfg(windows)]
fn minimum_frame(window: &tauri::WebviewWindow, scale: f64) -> (f64, f64) {
    match (window.outer_size(), window.inner_size()) {
        (Ok(outer), Ok(inner)) => (
            f64::from(outer.width.saturating_sub(inner.width)) / scale,
            f64::from(outer.height.saturating_sub(inner.height)) / scale,
        ),
        _ => (0.0, 0.0),
    }
}

// GTK applies the minimum to the page itself
#[cfg(not(windows))]
fn minimum_frame(_window: &tauri::WebviewWindow, _scale: f64) -> (f64, f64) {
    (0.0, 0.0)
}

// clearing old page zoom also moves the maximize button under its Snap Layouts overlay
#[cfg(windows)]
fn place_caption_overlay(window: &tauri::WebviewWindow) {
    let target = window.as_ref().window();
    let _ = window.run_on_main_thread(move || {
        crate::platform::windows_caption::reposition(&target);
    });
}

#[cfg(not(windows))]
fn place_caption_overlay(_window: &tauri::WebviewWindow) {}

fn validate_notification(title: &str, body: &str) -> Result<(), PublicBackendError> {
    let invalid = |text: &str, max: usize| {
        text.trim().is_empty() || text.chars().count() > max || text.chars().any(char::is_control)
    };
    if invalid(title, MAX_NOTIFICATION_TITLE)
        || (!body.is_empty() && invalid(body, MAX_NOTIFICATION_BODY))
    {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "The notification text is empty, too long, or has control characters.",
        ));
    }
    Ok(())
}

/// Shows a system notification, but only while Tuck isn't the focused window; when it is, the
/// queue's own status already says the same thing. Returns whether one was shown.
#[tauri::command]
pub fn notify_when_unfocused(
    window: tauri::WebviewWindow,
    title: String,
    body: String,
) -> Result<bool, PublicBackendError> {
    validate_notification(&title, &body)?;
    if window.is_focused().unwrap_or(false) {
        return Ok(false);
    }
    let mut notification = window.notification().builder().title(title);
    if !body.is_empty() {
        notification = notification.body(body);
    }
    notification.show().map_err(|_| {
        PublicBackendError::new("INTERNAL_ERROR", "Could not show the notification.")
    })?;
    Ok(true)
}

/// What the taskbar button shows for the export queue.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskbarProgress {
    None,
    Normal,
    Indeterminate,
    Error,
}

fn progress_bar_state(
    state: TaskbarProgress,
    progress: Option<u8>,
) -> Result<ProgressBarState, PublicBackendError> {
    if progress.is_some_and(|value| value > 100) {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Taskbar progress must be between 0 and 100.",
        ));
    }
    let progress = progress.map(u64::from);
    let (status, progress) = match state {
        TaskbarProgress::None => (ProgressBarStatus::None, None),
        TaskbarProgress::Normal => (ProgressBarStatus::Normal, Some(progress.unwrap_or(0))),
        TaskbarProgress::Indeterminate => (ProgressBarStatus::Indeterminate, None),
        // a failed batch fills the button red so it reads as finished, not stuck
        TaskbarProgress::Error => (ProgressBarStatus::Error, Some(progress.unwrap_or(100))),
    };
    Ok(ProgressBarState {
        status: Some(status),
        progress,
    })
}

/// Mirrors queue progress on the taskbar button. `flash` asks for attention once, and only
/// while Tuck is in the background. Linux shows this only on desktops with libunity.
#[tauri::command]
pub fn set_taskbar_progress(
    window: tauri::WebviewWindow,
    state: TaskbarProgress,
    progress: Option<u8>,
    flash: bool,
) -> Result<(), PublicBackendError> {
    let bar = progress_bar_state(state, progress)?;
    window.set_progress_bar(bar).map_err(|_| {
        PublicBackendError::new("INTERNAL_ERROR", "Could not update the taskbar progress.")
    })?;
    if flash && !window.is_focused().unwrap_or(false) {
        // the progress already shows the result, so a refused flash isn't worth an error
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_parse_from_the_stored_setting_names_only() {
        for (name, size) in [
            ("compact", InterfaceSize::Compact),
            ("default", InterfaceSize::Default),
            ("large", InterfaceSize::Large),
        ] {
            assert_eq!(
                serde_json::from_value::<InterfaceSize>(serde_json::json!(name)).unwrap(),
                size
            );
        }
        for name in ["Large", "huge", "", "1.5"] {
            assert!(serde_json::from_value::<InterfaceSize>(serde_json::json!(name)).is_err());
        }
    }

    #[test]
    fn the_minimum_window_keeps_the_layout_at_960_by_640() {
        for size in [
            InterfaceSize::Compact,
            InterfaceSize::Default,
            InterfaceSize::Large,
        ] {
            assert_eq!(size.min_window_size(), (960.0, 640.0));
        }
    }

    #[test]
    fn density_never_changes_page_zoom() {
        for size in [
            InterfaceSize::Compact,
            InterfaceSize::Default,
            InterfaceSize::Large,
        ] {
            assert_eq!(size.zoom(), 1.0);
        }
    }

    #[test]
    fn notification_text_is_checked() {
        assert!(validate_notification("Exports finished", "3 videos saved").is_ok());
        assert!(validate_notification("Exports finished", "").is_ok());
        assert!(validate_notification("", "body").is_err());
        assert!(validate_notification("   ", "body").is_err());
        assert!(validate_notification("Title\u{0007}", "body").is_err());
        assert!(validate_notification("Title", &"a".repeat(MAX_NOTIFICATION_BODY + 1)).is_err());
    }

    #[test]
    fn taskbar_states_parse_from_their_names_only() {
        for (name, state) in [
            ("none", TaskbarProgress::None),
            ("normal", TaskbarProgress::Normal),
            ("indeterminate", TaskbarProgress::Indeterminate),
            ("error", TaskbarProgress::Error),
        ] {
            assert_eq!(
                serde_json::from_value::<TaskbarProgress>(serde_json::json!(name)).unwrap(),
                state
            );
        }
        for name in ["Normal", "paused", ""] {
            assert!(serde_json::from_value::<TaskbarProgress>(serde_json::json!(name)).is_err());
        }
    }

    #[test]
    fn taskbar_progress_maps_to_the_native_bar() {
        let bar = progress_bar_state(TaskbarProgress::Normal, Some(42)).unwrap();
        assert!(matches!(bar.status, Some(ProgressBarStatus::Normal)));
        assert_eq!(bar.progress, Some(42));

        let bar = progress_bar_state(TaskbarProgress::Indeterminate, Some(42)).unwrap();
        assert!(matches!(bar.status, Some(ProgressBarStatus::Indeterminate)));
        assert_eq!(bar.progress, None);

        let bar = progress_bar_state(TaskbarProgress::Error, None).unwrap();
        assert!(matches!(bar.status, Some(ProgressBarStatus::Error)));
        assert_eq!(bar.progress, Some(100));

        let bar = progress_bar_state(TaskbarProgress::None, Some(10)).unwrap();
        assert!(matches!(bar.status, Some(ProgressBarStatus::None)));
        assert_eq!(bar.progress, None);

        assert!(progress_bar_state(TaskbarProgress::Normal, Some(101)).is_err());
    }
}
