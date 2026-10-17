use crate::backend::protocol::PublicBackendError;
use crate::platform::window_chrome::css_to_physical;
use crate::player::{preview_mode, PreviewMode, Viewport};

fn surface_error(message: &str) -> PublicBackendError {
    PublicBackendError::new("PREVIEW_SURFACE_FAILED", message)
}

// the page cannot turn the surface on by itself; only this run's switch can
fn require_surface_mode() -> Result<(), PublicBackendError> {
    if preview_mode() == PreviewMode::Surface {
        Ok(())
    } else {
        Err(PublicBackendError::new(
            "NOT_AVAILABLE",
            "The native preview is not turned on.",
        ))
    }
}

/// Creates the surface below the page and makes the page's background transparent.
#[tauri::command]
pub async fn preview_surface_open(window: tauri::WebviewWindow) -> Result<(), PublicBackendError> {
    require_surface_mode()?;
    window
        .set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)))
        .map_err(|_| surface_error("Could not make the page background transparent."))?;
    open_surface(&window).await
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
            let _ = sender.send(crate::player::surface_windows::open(parent).is_ok());
        })
        .map_err(|_| surface_error("Could not create the preview."))?;
    match receiver.await {
        Ok(true) => Ok(()),
        _ => Err(surface_error("Could not create the preview.")),
    }
}

#[cfg(target_os = "linux")]
async fn open_surface(window: &tauri::WebviewWindow) -> Result<(), PublicBackendError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let result = crate::player::surface_linux::open(&webview.inner());
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
