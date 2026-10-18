use crate::backend::protocol::PublicBackendError;
use crate::platform::window_chrome::{validate_menu_point, CaptionArea, WindowChromeState};

fn window_error(message: &str) -> PublicBackendError {
    PublicBackendError::new("INTERNAL_ERROR", message)
}

#[tauri::command]
pub fn minimize_window(window: tauri::Window) -> Result<(), PublicBackendError> {
    window
        .minimize()
        .map_err(|_| window_error("Could not minimize the window."))
}

#[tauri::command]
pub fn toggle_maximize_window(window: tauri::Window) -> Result<(), PublicBackendError> {
    let maximized = window
        .is_maximized()
        .map_err(|_| window_error("Could not read the window size."))?;
    if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(|_| window_error("Could not resize the window."))
}

/// Puts the window in or out of full screen for the player's stage, where the page can't use
/// element fullscreen. Answers whether the window was already full screen, so the page leaves a
/// window the desktop made full screen as it was.
#[tauri::command]
pub fn set_window_fullscreen(
    window: tauri::Window,
    fullscreen: bool,
) -> Result<bool, PublicBackendError> {
    let was_fullscreen = window
        .is_fullscreen()
        .map_err(|_| window_error("Could not read the window state."))?;
    if was_fullscreen != fullscreen {
        window
            .set_fullscreen(fullscreen)
            .map_err(|_| window_error("Could not change full screen."))?;
    }
    Ok(was_fullscreen)
}

/// Tells the native layer where the title bar's maximize button is, or `None` while the title bar
/// is hidden (full screen), so Windows can offer Snap Layouts over it.
#[tauri::command]
pub fn set_caption_maximize_area(
    window: tauri::Window,
    area: Option<CaptionArea>,
) -> Result<WindowChromeState, PublicBackendError> {
    let area = area
        .map(CaptionArea::validate)
        .transpose()
        .map_err(|message| PublicBackendError::new("INVALID_REQUEST", message))?;
    place_maximize_area(&window, area)
}

#[cfg(windows)]
fn place_maximize_area(
    window: &tauri::Window,
    area: Option<CaptionArea>,
) -> Result<WindowChromeState, PublicBackendError> {
    use crate::platform::windows_caption;
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            if let Err(error) = windows_caption::set_maximize_area(&target, area) {
                eprintln!("could not place the maximize button overlay: {error}");
            }
        })
        .map_err(|_| window_error("Could not update the title bar."))?;
    Ok(WindowChromeState {
        maximized: windows_caption::is_maximized(window),
    })
}

#[cfg(not(windows))]
fn place_maximize_area(
    _window: &tauri::Window,
    _area: Option<CaptionArea>,
) -> Result<WindowChromeState, PublicBackendError> {
    Err(PublicBackendError::new(
        "UNSUPPORTED_OPERATION",
        "This platform keeps its own title bar.",
    ))
}

/// Opens the standard window menu (Restore, Move, Size, Minimize, Maximize, Close) at a point in
/// the title bar, in CSS pixels.
#[tauri::command]
pub fn show_window_menu(window: tauri::Window, x: f64, y: f64) -> Result<(), PublicBackendError> {
    let (x, y) = validate_menu_point(x, y)
        .map_err(|message| PublicBackendError::new("INVALID_REQUEST", message))?;
    open_window_menu(&window, x, y)
}

#[cfg(windows)]
fn open_window_menu(window: &tauri::Window, x: f64, y: f64) -> Result<(), PublicBackendError> {
    use crate::platform::windows_caption;
    let target = window.clone();
    // the menu runs its own modal loop, so it opens after this IPC call has returned
    window
        .run_on_main_thread(move || windows_caption::show_window_menu(&target, x, y))
        .map_err(|_| window_error("Could not open the window menu."))
}

#[cfg(not(windows))]
fn open_window_menu(_window: &tauri::Window, _x: f64, _y: f64) -> Result<(), PublicBackendError> {
    Err(PublicBackendError::new(
        "UNSUPPORTED_OPERATION",
        "This platform keeps its own title bar.",
    ))
}
