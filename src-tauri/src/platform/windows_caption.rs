//! Window chrome for the custom title bar on Windows.
//!
//! Windows 11 only offers Snap Layouts to a window that answers `WM_NCHITTEST` with
//! `HTMAXBUTTON`. WebView2 covers the whole client area and routes input through its own child
//! windows, which cannot be subclassed, so a transparent child window sits over the HTML maximize
//! button and answers for it. This is the same approach Windows Terminal and Electron use.

use std::cell::{Cell, RefCell};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Window};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, GetStockObject, ValidateRect, HBRUSH, NULL_BRUSH,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, EnableMenuItem, GetClientRect, GetParent, GetSystemMenu,
    IsZoomed, LoadCursorW, PostMessageW, RegisterClassExW, SetForegroundWindow, SetMenuDefaultItem,
    SetWindowPos, ShowWindow, TrackPopupMenu, HTMAXBUTTON, HWND_TOP, IDC_ARROW, MENU_ITEM_FLAGS,
    MF_BYCOMMAND, MF_ENABLED, MF_GRAYED, SC_CLOSE, SC_MAXIMIZE, SC_MINIMIZE, SC_MOVE, SC_RESTORE,
    SC_SIZE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, TPM_LEFTALIGN, TPM_RETURNCMD,
    TPM_RIGHTBUTTON, TPM_TOPALIGN, WINDOW_EX_STYLE, WM_ERASEBKGND, WM_NCHITTEST,
    WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE,
    WM_PAINT, WM_SYSCOMMAND, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
};

use super::window_chrome::{css_to_physical, CaptionArea};

pub const MAXIMIZE_HOVER_EVENT: &str = "caption-maximize";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MaximizeButtonState {
    pub hovered: bool,
    pub pressed: bool,
}

static APP: OnceLock<AppHandle> = OnceLock::new();

// the overlay is created, moved and driven only on the main thread, which owns the window
thread_local! {
    static OVERLAY: RefCell<Option<Overlay>> = const { RefCell::new(None) };
    static BUTTON: Cell<MaximizeButtonState> = const { Cell::new(MaximizeButtonState { hovered: false, pressed: false }) };
}

struct Overlay {
    hwnd: HWND,
    area: Option<CaptionArea>,
}

pub fn remember_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn parent_hwnd(window: &Window) -> Option<HWND> {
    window.hwnd().ok()
}

/// Places the overlay over the maximize button, or hides it when the title bar is not showing.
/// Must run on the main thread.
pub fn set_maximize_area(window: &Window, area: Option<CaptionArea>) -> windows::core::Result<()> {
    let Some(parent) = parent_hwnd(window) else {
        return Ok(());
    };
    OVERLAY.with(|cell| -> windows::core::Result<()> {
        let mut overlay = cell.borrow_mut();
        if overlay.is_none() {
            if area.is_none() {
                return Ok(());
            }
            *overlay = Some(Overlay {
                hwnd: create_overlay(parent)?,
                area: None,
            });
        }
        if let Some(overlay) = overlay.as_mut() {
            overlay.area = area;
        }
        Ok(())
    })?;
    reposition(window);
    Ok(())
}

/// Keeps the overlay on the maximize button as the window resizes. Must run on the main thread.
pub fn reposition(window: &Window) {
    let Some(parent) = parent_hwnd(window) else {
        return;
    };
    let scale = css_to_physical(window.scale_factor().unwrap_or(1.0));
    OVERLAY.with(|cell| {
        let overlay = cell.borrow();
        let Some(overlay) = overlay.as_ref() else {
            return;
        };
        unsafe {
            let Some(area) = overlay.area else {
                let _ = ShowWindow(overlay.hwnd, SW_HIDE);
                return;
            };
            let mut client = RECT::default();
            if GetClientRect(parent, &mut client).is_err() {
                return;
            }
            let (x, width, height) = area.physical(client.right, scale);
            // WebView2 can raise its own windows later, so the overlay goes back on top every time
            let _ = SetWindowPos(
                overlay.hwnd,
                Some(HWND_TOP),
                x,
                0,
                width,
                height,
                SWP_SHOWWINDOW | SWP_NOACTIVATE,
            );
        }
    });
}

pub fn is_maximized(window: &Window) -> bool {
    parent_hwnd(window).is_some_and(|hwnd| unsafe { IsZoomed(hwnd).as_bool() })
}

/// Opens the standard window menu at a point in the client area, in CSS pixels.
/// Must run on the main thread.
pub fn show_window_menu(window: &Window, x: f64, y: f64) {
    let Some(hwnd) = parent_hwnd(window) else {
        return;
    };
    let scale = css_to_physical(window.scale_factor().unwrap_or(1.0));
    unsafe {
        let menu = GetSystemMenu(hwnd, false);
        if menu.is_invalid() {
            return;
        }
        // without a native caption Windows no longer updates these, so set them like it would
        let maximized = IsZoomed(hwnd).as_bool();
        let state = |enabled: bool| -> MENU_ITEM_FLAGS {
            MF_BYCOMMAND | if enabled { MF_ENABLED } else { MF_GRAYED }
        };
        let _ = EnableMenuItem(menu, SC_RESTORE, state(maximized));
        let _ = EnableMenuItem(menu, SC_MOVE, state(!maximized));
        let _ = EnableMenuItem(menu, SC_SIZE, state(!maximized));
        let _ = EnableMenuItem(menu, SC_MINIMIZE, state(true));
        let _ = EnableMenuItem(menu, SC_MAXIMIZE, state(!maximized));
        let _ = EnableMenuItem(menu, SC_CLOSE, state(true));
        let _ = SetMenuDefaultItem(menu, SC_CLOSE, 0);

        let mut point = POINT {
            x: (x * scale).round() as i32,
            y: (y * scale).round() as i32,
        };
        let _ = ClientToScreen(hwnd, &mut point);
        // the menu only dismisses on an outside click while its owner is in front
        let _ = SetForegroundWindow(hwnd);
        let command = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_LEFTALIGN | TPM_TOPALIGN | TPM_RIGHTBUTTON,
            point.x,
            point.y,
            None,
            hwnd,
            None,
        );
        if command.0 != 0 {
            let _ = PostMessageW(
                Some(hwnd),
                WM_SYSCOMMAND,
                WPARAM(command.0 as usize),
                LPARAM(0),
            );
        }
    }
}

fn create_overlay(parent: HWND) -> windows::core::Result<HWND> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(overlay_proc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            // never painting is what keeps it invisible; layered or transparent styles break the hit test
            hbrBackground: HBRUSH(GetStockObject(NULL_BRUSH).0),
            lpszClassName: w!("TuckCaptionMaximize"),
            ..Default::default()
        };
        // a second registration fails harmlessly once the class exists
        RegisterClassExW(&class);
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("TuckCaptionMaximize"),
            w!(""),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            Some(parent),
            None,
            Some(instance.into()),
            None,
        )
    }
}

fn set_button(next: MaximizeButtonState) {
    if BUTTON.with(|cell| cell.replace(next)) == next {
        return;
    }
    if let Some(app) = APP.get() {
        let _ = app.emit(MAXIMIZE_HOVER_EVENT, next);
    }
}

unsafe extern "system" fn overlay_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCHITTEST => LRESULT(HTMAXBUTTON as isize),
        WM_NCMOUSEMOVE => {
            let current = BUTTON.with(Cell::get);
            if !current.hovered {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                let _ = TrackMouseEvent(&mut track);
                set_button(MaximizeButtonState {
                    hovered: true,
                    ..current
                });
            }
            LRESULT(0)
        }
        WM_NCMOUSELEAVE => {
            set_button(MaximizeButtonState::default());
            LRESULT(0)
        }
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
            set_button(MaximizeButtonState {
                hovered: true,
                pressed: true,
            });
            LRESULT(0)
        }
        WM_NCLBUTTONUP => {
            let was_pressed = BUTTON.with(Cell::get).pressed;
            set_button(MaximizeButtonState {
                hovered: true,
                pressed: false,
            });
            if was_pressed {
                if let Ok(parent) = GetParent(hwnd) {
                    let command = if IsZoomed(parent).as_bool() {
                        SC_RESTORE
                    } else {
                        SC_MAXIMIZE
                    };
                    let _ = PostMessageW(
                        Some(parent),
                        WM_SYSCOMMAND,
                        WPARAM(command as usize),
                        LPARAM(0),
                    );
                }
            }
            LRESULT(0)
        }
        WM_PAINT => {
            let _ = ValidateRect(Some(hwnd), None);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}
