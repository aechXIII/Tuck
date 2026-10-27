//! Drags finished exports out of the window as files, so they can be dropped into a chat, a
//! browser upload or a file manager. A web page can't start a drag the desktop sees as a file,
//! so the desktop shell starts it on the page's behalf.

use std::path::PathBuf;

use crate::backend::protocol::PublicBackendError;

/// Whether this build can drag a file out of the window. The page only offers dragging where it
/// can; Windows needs its own OLE drag source first.
pub const SUPPORTED: bool = cfg!(target_os = "linux");

#[cfg(target_os = "linux")]
fn drag_error() -> PublicBackendError {
    PublicBackendError::new(
        "UNSUPPORTED_OPERATION",
        "The desktop didn't start the drag. Use Copy file and paste it instead.",
    )
}

#[cfg(target_os = "linux")]
thread_local! {
    // the window's handlers for the drag in progress; GTK runs on one thread, so this is per drag
    static DRAG_HANDLERS: std::cell::RefCell<Vec<gtk::glib::SignalHandlerId>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(target_os = "linux")]
fn clear_drag_handlers(window: &gtk::ApplicationWindow) {
    use gtk::glib::ObjectExt;
    DRAG_HANDLERS.with(|handlers| {
        for handler in handlers.borrow_mut().drain(..) {
            window.disconnect(handler);
        }
    });
}

/// Starts one drag carrying every file in `paths`. Must run on the main thread while the primary
/// button is still held; returns `Ok(false)` without dragging once it has been let go.
#[cfg(target_os = "linux")]
pub fn start(
    window: &tauri::WebviewWindow,
    webview: &tauri::webview::PlatformWebview,
    paths: &[PathBuf],
) -> Result<bool, PublicBackendError> {
    use gtk::gdk;
    use gtk::prelude::*;

    let window = window.gtk_window().map_err(|_| drag_error())?;
    let page = webview.inner();
    let uris = crate::platform::file_clipboard::file_uris(paths).ok_or_else(drag_error)?;

    // GTK finishes a drag on the button's release; started after it, the file would stay on the
    // pointer until the next click
    let held = window
        .window()
        .zip(
            window
                .display()
                .default_seat()
                .and_then(|seat| seat.pointer()),
        )
        .is_some_and(|(surface, pointer)| {
            let (_, _, _, state) = surface.device_position(&pointer);
            state.contains(gdk::ModifierType::BUTTON1_MASK)
        });
    if !held {
        return Ok(false);
    }

    // a drag whose end never arrived must not hand its files to this one
    clear_drag_handlers(&window);
    let targets = gtk::TargetList::new(&[gtk::TargetEntry::new(
        "text/uri-list",
        gtk::TargetFlags::empty(),
        0,
    )]);
    let data = window.connect_drag_data_get(move |_, _, selection, _, _| {
        let uris: Vec<&str> = uris.iter().map(String::as_str).collect();
        selection.set_uris(&uris);
    });
    let end = window.connect_drag_end(move |window, _| {
        clear_drag_handlers(window);
        end_press(&page);
    });
    DRAG_HANDLERS.with(|handlers| handlers.borrow_mut().extend([data, end]));

    let Some(context) =
        window.drag_begin_with_coordinates(&targets, gdk::DragAction::COPY, 1, None, -1, -1)
    else {
        clear_drag_handlers(&window);
        return Err(drag_error());
    };
    context.drag_set_icon_name("video-x-generic", 0, 0);
    Ok(true)
}

/// Gives the webview the release of the press that started a drag. The drag takes that release,
/// so WebKit would still count the button as down and turn the next press into a pointer move:
/// the page would get no `pointerdown`, which drags, scrubs and the next drag out start from.
#[cfg(target_os = "linux")]
fn end_press(webview: &webkit2gtk::WebView) {
    use gtk::prelude::*;

    let Some(surface) = webview.window() else {
        return;
    };
    let Some(pointer) = webview
        .display()
        .default_seat()
        .and_then(|seat| seat.pointer())
    else {
        return;
    };
    let (_, x, y, _) = surface.device_position_double(&pointer);
    let release = button_event(&surface, &pointer, gtk::gdk::EventType::ButtonRelease, x, y);
    webview.event(&release);
}

/// A primary button event on `surface` at `x`, `y` in its own coordinates.
#[cfg(target_os = "linux")]
fn button_event(
    surface: &gtk::gdk::Window,
    pointer: &gtk::gdk::Device,
    kind: gtk::gdk::EventType,
    x: f64,
    y: f64,
) -> gtk::gdk::Event {
    use gtk::gdk::ModifierType;
    use gtk::glib::translate::{ToGlibPtr, ToGlibPtrMut};

    let (_, left, top) = surface.origin();
    // the state is the one before the event: the button is down as it is released
    let state = if kind == gtk::gdk::EventType::ButtonRelease {
        ModifierType::BUTTON1_MASK
    } else {
        ModifierType::empty()
    };
    let mut event = gtk::gdk::Event::new(kind);
    event.set_device(Some(pointer));
    event.set_source_device(Some(pointer));
    // GDK has no setters for these fields; the event owns the window reference and frees it
    // with the event
    unsafe {
        let raw: *mut gtk::gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
        let button = &mut (*raw).button;
        button.window = surface.to_glib_full();
        button.send_event = 1;
        button.time = gtk::current_event_time();
        button.x = x;
        button.y = y;
        button.x_root = f64::from(left) + x;
        button.y_root = f64::from(top) + y;
        button.state = state.bits();
        button.button = 1;
    }
    event
}

#[cfg(not(target_os = "linux"))]
pub fn start(
    _window: &tauri::WebviewWindow,
    _webview: &tauri::webview::PlatformWebview,
    _paths: &[PathBuf],
) -> Result<bool, PublicBackendError> {
    Err(PublicBackendError::new(
        "UNSUPPORTED_OPERATION",
        "Dragging exports out isn't available on this system yet. Use Copy file instead.",
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::time::{Duration, Instant};

    use gtk::prelude::*;
    use webkit2gtk::WebViewExt;

    use super::{button_event, end_press};

    // the page shows how many pointerdown and mousedown events it got in its title
    const PAGE: &str = "<body style=\"margin:0;height:100vh\"><script>
        let downs = 0, presses = 0;
        const show = () => { document.title = `${downs} ${presses}`; };
        addEventListener('pointerdown', () => { downs++; show(); });
        addEventListener('mousedown', () => { presses++; show(); });
        show();
        </script></body>";

    fn wait_for_title(webview: &webkit2gtk::WebView, title: &str) -> String {
        let context = gtk::glib::MainContext::default();
        // wakes the loop now and then, so a page that never answers fails instead of hanging
        let tick = gtk::glib::timeout_add_local(Duration::from_millis(50), || {
            gtk::glib::ControlFlow::Continue
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        while webview.title().as_deref() != Some(title) && Instant::now() < deadline {
            context.iteration(true);
        }
        tick.remove();
        webview.title().map(String::from).unwrap_or_default()
    }

    fn press(webview: &webkit2gtk::WebView) {
        let surface = webview.window().unwrap();
        let pointer = webview
            .display()
            .default_seat()
            .and_then(|seat| seat.pointer())
            .unwrap();
        let event = button_event(
            &surface,
            &pointer,
            gtk::gdk::EventType::ButtonPress,
            40.0,
            40.0,
        );
        webview.event(&event);
    }

    #[test]
    #[ignore = "requires an isolated graphical display, such as xvfb-run"]
    fn file_drag_linux_ending_a_drag_gives_the_page_its_next_pointerdown() {
        gtk::init().unwrap();
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        window.set_default_size(160, 120);
        let webview = webkit2gtk::WebView::new();
        window.add(&webview);
        webview.load_html(PAGE, None);
        window.show_all();
        assert_eq!(wait_for_title(&webview, "0 0"), "0 0");

        press(&webview);
        assert_eq!(wait_for_title(&webview, "1 1"), "1 1");
        // a drag took that press's release, so to the page the next press only moves the pointer
        press(&webview);
        assert_eq!(wait_for_title(&webview, "1 2"), "1 2");

        end_press(&webview);
        press(&webview);
        assert_eq!(wait_for_title(&webview, "2 3"), "2 3");
    }
}
