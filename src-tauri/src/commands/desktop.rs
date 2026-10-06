use serde::Deserialize;
use tauri::LogicalSize;
use tauri_plugin_notification::NotificationExt;

use crate::backend::protocol::PublicBackendError;

/// The layout is designed for at least this many CSS pixels.
const MIN_LAYOUT_WIDTH: f64 = 960.0;
const MIN_LAYOUT_HEIGHT: f64 = 640.0;

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
        match self {
            Self::Compact => 0.9,
            Self::Default => 1.0,
            Self::Large => 1.1,
        }
    }

    /// The smallest window, in logical pixels, that still gives the page its minimum layout.
    pub fn min_window_size(self) -> (f64, f64) {
        (
            (MIN_LAYOUT_WIDTH * self.zoom()).round(),
            (MIN_LAYOUT_HEIGHT * self.zoom()).round(),
        )
    }
}

/// Scales the whole interface, like browser zoom. The window's minimum size follows the scale so
/// a larger interface can't squeeze the layout below its supported size.
#[tauri::command]
pub fn set_interface_size(
    window: tauri::WebviewWindow,
    size: InterfaceSize,
) -> Result<(), PublicBackendError> {
    let failed =
        |_| PublicBackendError::new("INTERNAL_ERROR", "Could not change the interface size.");
    let scale = window.scale_factor().map_err(failed)?;
    let (mut min_width, mut min_height) = size.min_window_size();
    // on a small screen the larger size can't ask for a window bigger than the screen
    if let Ok(Some(monitor)) = window.current_monitor() {
        let screen = monitor
            .work_area()
            .size
            .to_logical::<f64>(monitor.scale_factor());
        min_width = min_width.min(screen.width);
        min_height = min_height.min(screen.height);
    }
    window
        .set_min_size(Some(LogicalSize::new(min_width, min_height)))
        .map_err(failed)?;
    let current = window
        .inner_size()
        .map_err(failed)?
        .to_logical::<f64>(scale);
    let maximized = window.is_maximized().unwrap_or(false);
    if !maximized && (current.width < min_width || current.height < min_height) {
        window
            .set_size(LogicalSize::new(
                current.width.max(min_width),
                current.height.max(min_height),
            ))
            .map_err(failed)?;
    }
    window.set_zoom(size.zoom()).map_err(failed)?;
    crate::platform::window_chrome::set_page_zoom(size.zoom());
    place_caption_overlay(&window);
    Ok(())
}

// the Snap Layouts overlay sits over the page's maximize button, which moves with the zoom
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
        assert_eq!(InterfaceSize::Default.min_window_size(), (960.0, 640.0));
        assert_eq!(InterfaceSize::Large.min_window_size(), (1056.0, 704.0));
        assert_eq!(InterfaceSize::Compact.min_window_size(), (864.0, 576.0));
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
}
