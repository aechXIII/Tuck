//! Drags finished exports out of the window as files, so they can be dropped into a chat, a
//! browser upload or a file manager. A web page can't start a drag the desktop sees as a file,
//! so the desktop shell starts it on the page's behalf.

use std::path::PathBuf;

use crate::backend::protocol::PublicBackendError;

/// Whether this build can drag a file out of the window. The page only offers dragging where it
/// can.
pub const SUPPORTED: bool = cfg!(any(target_os = "linux", windows));

/// Told when a drag that started is over, dropped or not; dropped unsent, it means the same.
pub type DragEnded = tokio::sync::oneshot::Sender<()>;

#[cfg(any(target_os = "linux", windows))]
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
/// button is still held; returns `Ok(false)` without dragging once it has been let go. The drag
/// goes on after this returns, and `ended` hears when it is over.
#[cfg(target_os = "linux")]
pub fn start(
    window: &tauri::WebviewWindow,
    webview: &tauri::webview::PlatformWebview,
    paths: &[PathBuf],
    ended: DragEnded,
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
    let ended = std::cell::Cell::new(Some(ended));
    let end = window.connect_drag_end(move |window, _| {
        clear_drag_handlers(window);
        end_press(&page);
        if let Some(ended) = ended.take() {
            let _ = ended.send(());
        }
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

/// Starts one drag carrying every file in `paths`, like the Linux one. The shell's drag runs its
/// own loop until the drop, so this returns once the files have been dropped or the drag let go,
/// and dropping `_ended` then says so.
#[cfg(windows)]
pub fn start(
    window: &tauri::WebviewWindow,
    _webview: &tauri::webview::PlatformWebview,
    paths: &[PathBuf],
    _ended: DragEnded,
) -> Result<bool, PublicBackendError> {
    windows_drag::start(window, paths)
}

#[cfg(windows)]
mod windows_drag {
    use std::path::PathBuf;

    use windows::core::PCWSTR;
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{
        IDropSource, OleInitialize, OleUninitialize, DROPEFFECT_COPY,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, ILCreateFromPathW, ILFree, SHCreateDataObject, SHDoDragDrop,
        SHGetKnownFolderIDList, KF_FLAG_DEFAULT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};

    use super::drag_error;
    use crate::backend::protocol::PublicBackendError;
    use crate::platform::file_clipboard::shell_path;

    /// Item IDs the shell made for the dragged files, freed once the drag is over.
    struct ItemIds(Vec<*mut ITEMIDLIST>);

    impl Drop for ItemIds {
        fn drop(&mut self) {
            for id in self.0.drain(..) {
                unsafe { ILFree(Some(id.cast_const())) };
            }
        }
    }

    fn primary_button_held() -> bool {
        // GetAsyncKeyState reads the physical buttons, so with swapped buttons the primary one is
        // the right
        let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
        let button = if swapped { VK_RBUTTON } else { VK_LBUTTON };
        // the high bit, so a negative state, means the button is down now
        let state = unsafe { GetAsyncKeyState(i32::from(button.0)) };
        state < 0
    }

    /// The shell's data object for `paths`, which hands the files over the way Explorer does: as
    /// item IDs, a file list and file contents. The item IDs stay alive with it until the drag
    /// is over.
    fn data_object(paths: &[PathBuf]) -> Result<(IDataObject, ItemIds), PublicBackendError> {
        let mut ids = ItemIds(Vec::with_capacity(paths.len()));
        for path in paths {
            let wide: Vec<u16> = shell_path(path).into_iter().chain([0]).collect();
            let id = unsafe { ILCreateFromPathW(PCWSTR(wide.as_ptr())) };
            if id.is_null() {
                return Err(drag_error());
            }
            ids.0.push(id);
        }
        let absolute: Vec<*const ITEMIDLIST> = ids.0.iter().map(|id| id.cast_const()).collect();
        // full item IDs are relative to the desktop, so the desktop is their folder and the files
        // need no common one. Given no folder at all, the shell makes an object with no formats,
        // and every app refuses the drop
        let desktop =
            unsafe { SHGetKnownFolderIDList(&FOLDERID_Desktop, KF_FLAG_DEFAULT.0 as u32, None) }
                .map_err(|_| drag_error())?;
        let desktop = ItemIds(vec![desktop]);
        let data: IDataObject = unsafe {
            SHCreateDataObject(
                Some(desktop.0[0].cast_const()),
                Some(&absolute),
                None::<&IDataObject>,
            )
        }
        .map_err(|_| drag_error())?;
        Ok((data, ids))
    }

    pub(super) fn start(
        window: &tauri::WebviewWindow,
        paths: &[PathBuf],
    ) -> Result<bool, PublicBackendError> {
        // the drag ends on the button's release; started after it, it would end at once
        if !primary_button_held() {
            return Ok(false);
        }
        let owner = window.hwnd().map_err(|_| drag_error())?;
        let (data, _ids) = data_object(paths)?;
        // OLE is usually set up on the window's thread already; this only counts one more use
        let ole = unsafe { OleInitialize(None) }.is_ok();
        // the shell's own drag source draws the files' pictures and ends the drag on release
        let dropped =
            unsafe { SHDoDragDrop(Some(owner), &data, None::<&IDropSource>, DROPEFFECT_COPY) };
        if ole {
            unsafe { OleUninitialize() };
        }
        dropped.map(|_| true).map_err(|_| drag_error())
    }

    #[cfg(test)]
    mod tests {
        use std::os::windows::ffi::OsStringExt;
        use std::path::PathBuf;

        use windows::Win32::System::Com::{DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
        use windows::Win32::System::Ole::{OleInitialize, ReleaseStgMedium, CF_HDROP};
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

        use super::data_object;

        #[test]
        fn file_drag_windows_hands_over_a_file_list_from_any_folders() {
            let root = std::env::temp_dir().join(format!("tuck-file-drag-{}", std::process::id()));
            let other = root.join("Other folder");
            std::fs::create_dir_all(&other).unwrap();
            let paths = vec![root.join("Replay ünïcode 1.mp4"), other.join("Clip 2.mp4")];
            for path in &paths {
                std::fs::write(path, b"video").unwrap();
            }

            let _ = unsafe { OleInitialize(None) };
            let (data, _ids) = data_object(&paths).unwrap();
            let format = FORMATETC {
                cfFormat: CF_HDROP.0,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            // browsers, chat apps and file managers take a drop by its file list
            let mut medium = unsafe { data.GetData(&format) }.unwrap();
            let files = HDROP(unsafe { medium.u.hGlobal.0 });
            let count = unsafe { DragQueryFileW(files, u32::MAX, None) };
            let mut dropped = Vec::new();
            for index in 0..count {
                let length = unsafe { DragQueryFileW(files, index, None) } as usize;
                let mut name = vec![0_u16; length + 1];
                let copied = unsafe { DragQueryFileW(files, index, Some(&mut name)) } as usize;
                dropped.push(PathBuf::from(std::ffi::OsString::from_wide(
                    &name[..copied],
                )));
            }
            unsafe { ReleaseStgMedium(&mut medium) };

            let canonical = |list: &[PathBuf]| -> Vec<PathBuf> {
                list.iter()
                    .map(|path| std::fs::canonicalize(path).unwrap())
                    .collect()
            };
            let expected = canonical(&paths);
            let got = canonical(&dropped);
            std::fs::remove_dir_all(&root).unwrap();
            assert_eq!(got, expected);
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn start(
    _window: &tauri::WebviewWindow,
    _webview: &tauri::webview::PlatformWebview,
    _paths: &[PathBuf],
    _ended: DragEnded,
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
