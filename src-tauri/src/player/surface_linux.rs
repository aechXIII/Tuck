//! The preview surface on Linux. The runtime builds the webview into the window's default box. An
//! overlay takes that box's place as the window's child: the native picture is the overlay's base
//! layer and the webview is the layer above, with a transparent background. Wry accepts any
//! container as the webview's parent; only a fixed-position parent changes its behavior, and an
//! overlay is not one.
//!
//! The webview must stay exactly two levels under the window. On every left press the runtime's
//! resize handler takes the webview's parent's parent and unwraps it as the window, so an overlay
//! nested inside the box aborts Tuck on the first click. The runtime only uses the box again to add
//! menus, more webviews or a moved webview, and Tuck does none of those; tao keeps its own
//! reference to the box, so the detached box stays alive.
//!
//! The base layer is a test picture, or a GL area the native player library draws into. GTK draws
//! on its main thread only, so the area's frame clock asks the player whether a new frame is due
//! and its render handler has the library draw it.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use gtk::cairo;
use gtk::glib::{ControlFlow, Propagation};
use gtk::prelude::*;
use webkit2gtk::WebViewExt;

use super::engine::PlayerState;
use super::library::{GlRenderer, Target};
use super::Viewport;

// x, y, width and height in the area's own (logical) pixels
type Picture = (f64, f64, f64, f64);

struct Surface {
    area: gtk::Widget,
    // shared with the draw handler; none while there is no picture
    picture: Rc<RefCell<Option<Picture>>>,
}

// GTK objects live and are used only on the main thread
thread_local! {
    static SURFACE: RefCell<Option<Surface>> = const { RefCell::new(None) };
}

// nanoseconds between refreshes of the window's display, for the command threads; 0 until open
static REFRESH: AtomicU64 = AtomicU64::new(0);

/// Seconds between refreshes of the display the window is on, once the surface exists.
pub fn refresh_interval() -> Option<f64> {
    let nanoseconds = REFRESH.load(Ordering::Acquire);
    (nanoseconds != 0).then(|| nanoseconds as f64 / 1e9)
}

// whether the GL area's context takes GPU frames without a copy, for the command threads
static IMPORTS_FRAMES: AtomicBool = AtomicBool::new(false);

/// Whether the GL area can draw decoded GPU frames directly. GTK 3 under X11 uses GLX, which
/// can't, and Tuck's Linux package runs GTK under X11 even on Wayland desktops.
pub fn imports_frames() -> bool {
    IMPORTS_FRAMES.load(Ordering::Acquire)
}

/// Puts the surface under `webview`: the test picture, or with `player` a GL area it draws into.
/// Must run on the main thread.
pub fn open(
    webview: &webkit2gtk::WebView,
    player: Option<PlayerState>,
) -> Result<(), &'static str> {
    if SURFACE.with(|cell| cell.borrow().is_some()) {
        return Ok(());
    }
    let parent = webview
        .parent()
        .ok_or("The webview has no container yet.")?;
    let container = parent
        .downcast::<gtk::Box>()
        .map_err(|_| "The webview is not in the window's default box.")?;
    let window = container
        .parent()
        .and_then(|parent| parent.downcast::<gtk::Window>().ok())
        .ok_or("The window's default box is not in a window.")?;
    // anything else in the box, such as a menu bar, would be lost with it
    if container.children().len() != 1 {
        return Err("The window's default box holds more than the webview.");
    }

    let picture = Rc::new(RefCell::new(None));
    let area: gtk::Widget = match player {
        Some(player) => player_area(player, picture.clone()).upcast(),
        None => test_area(picture.clone()).upcast(),
    };

    let overlay = gtk::Overlay::new();
    overlay.add(&area);
    // the local reference keeps the webview alive while it has no parent
    let webview = webview.clone();
    container.remove(&webview);
    window.remove(&container);
    overlay.add_overlay(&webview);
    overlay.set_overlay_pass_through(&webview, false);
    window.add(&overlay);
    debug_assert!(webview
        .parent()
        .and_then(|parent| parent.parent())
        .is_some_and(|ancestor| ancestor.is::<gtk::Window>()));
    webview.set_background_color(&gtk::gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));
    overlay.show_all();
    webview.grab_focus();

    REFRESH.store(refresh_nanoseconds(&webview), Ordering::Release);
    SURFACE.with(|cell| *cell.borrow_mut() = Some(Surface { area, picture }));
    Ok(())
}

// the display's refresh rate, or 60 Hz when GDK doesn't know it
fn refresh_nanoseconds(webview: &webkit2gtk::WebView) -> u64 {
    let millihertz = webview
        .window()
        .and_then(|window| gtk::gdk::Display::default()?.monitor_at_window(&window))
        .map(|monitor| monitor.refresh_rate())
        .filter(|&rate| rate > 1000)
        .unwrap_or(60_000);
    1_000_000_000_000 / millihertz as u64
}

/// Moves the picture, or hides it while there is none. Must run on the main thread.
pub fn set_viewport(viewport: Viewport, pixels_per_css: f64) {
    SURFACE.with(|cell| {
        let Some(surface) = cell
            .borrow()
            .as_ref()
            .map(|s| (s.area.clone(), s.picture.clone()))
        else {
            return;
        };
        let (area, picture) = surface;
        *picture.borrow_mut() = if viewport.is_empty() {
            None
        } else {
            let (x, y, width, height) = viewport.device_rect(pixels_per_css);
            Some((x as f64, y as f64, width as f64, height as f64))
        };
        match area.downcast_ref::<gtk::GLArea>() {
            Some(gl) => gl.queue_render(),
            None => area.queue_draw(),
        }
    });
}

fn test_area(picture: Rc<RefCell<Option<Picture>>>) -> gtk::DrawingArea {
    let area = gtk::DrawingArea::new();
    area.connect_draw(move |_, context| {
        if let Some(rect) = *picture.borrow() {
            paint_test_picture(context, rect);
        }
        Propagation::Stop
    });
    area
}

fn player_area(player: PlayerState, picture: Rc<RefCell<Option<Picture>>>) -> gtk::GLArea {
    let area = gtk::GLArea::new();
    // drawing happens when a new frame is due, not on every GTK redraw
    area.set_auto_render(false);
    area.set_has_alpha(false);
    let renderer: Rc<RefCell<Option<GlRenderer>>> = Rc::default();
    let created = renderer.clone();
    area.connect_realize(move |area| {
        area.make_current();
        if area.error().is_some() {
            eprintln!("could not start OpenGL for the preview");
            return;
        }
        match GlRenderer::create() {
            Ok(renderer) => {
                IMPORTS_FRAMES.store(renderer.imports_frames(), Ordering::Release);
                *created.borrow_mut() = Some(renderer);
            }
            Err(message) => eprintln!("could not start the preview renderer: {message}"),
        }
    });
    let released = renderer.clone();
    area.connect_unrealize(move |area| {
        // libplacebo frees its GL objects with their own context current
        area.make_current();
        released.borrow_mut().take();
    });
    let drawing = player.clone();
    area.connect_render(move |area, _| {
        let target = target(area, *picture.borrow());
        if let Some(renderer) = renderer.borrow().as_ref() {
            if target.picture_width > 0 && target.picture_height > 0 {
                drawing.draw(renderer, &target, shown_at(area));
            } else {
                renderer.clear(&target);
            }
        }
        Propagation::Stop
    });
    area.add_tick_callback(move |area, _| {
        if player.due(shown_at(area)) {
            area.queue_render();
        }
        ControlFlow::Continue
    });
    area
}

// When this frame cycle's picture reaches the screen: the frame clock's time, which GTK keeps on the
// refresh grid, plus one refresh. The tick and the render handler of one cycle see the same time,
// so both pick the same frame. 0 (now) while the area has no frame clock.
fn shown_at(area: &gtk::GLArea) -> f64 {
    let Some(clock) = area.frame_clock() else {
        return 0.0;
    };
    let frame_time = clock.frame_time();
    if frame_time <= 0 {
        return 0.0;
    }
    let (interval, _) = clock.refresh_info(frame_time);
    let interval = if interval > 0 { interval } else { 16_667 };
    (frame_time + interval) as f64 / 1_000_000.0
}

// the area and the picture in device pixels; GTK positions are logical pixels
fn target(area: &gtk::GLArea, picture: Option<Picture>) -> Target {
    let scale = area.scale_factor();
    let device = |value: f64| (value * f64::from(scale)).round() as i32;
    let (x, y, width, height) = picture.unwrap_or_default();
    Target {
        width: area.allocated_width() * scale,
        height: area.allocated_height() * scale,
        picture_x: device(x),
        picture_y: device(y),
        picture_width: device(width),
        picture_height: device(height),
    }
}

// a test picture that makes misplacement, scaling and clipping easy to see in a screenshot
fn paint_test_picture(context: &cairo::Context, (x, y, width, height): Picture) {
    context.save().ok();
    context.rectangle(x, y, width, height);
    context.clip();
    let cell = (width.min(height) / 9.0).floor().max(8.0);
    let rows = (height / cell).ceil() as i32;
    let columns = (width / cell).ceil() as i32;
    for row in 0..rows {
        for column in 0..columns {
            let light = (row + column) % 2 == 0;
            let shade = if light {
                (58.0, 60.0, 70.0)
            } else {
                (32.0, 33.0, 40.0)
            };
            context.set_source_rgb(shade.0 / 255.0, shade.1 / 255.0, shade.2 / 255.0);
            context.rectangle(
                x + f64::from(column) * cell,
                y + f64::from(row) * cell,
                cell,
                cell,
            );
            let _ = context.fill();
        }
    }
    context.set_source_rgb(167.0 / 255.0, 139.0 / 255.0, 250.0 / 255.0);
    let border = 2.0;
    for (left, top, w, h) in [
        (x, y, width, border),
        (x, y + height - border, width, border),
        (x, y, border, height),
        (x + width - border, y, border, height),
        (x + width / 2.0 - 1.0, y, 2.0, height),
        (x, y + height / 2.0 - 1.0, width, 2.0),
    ] {
        context.rectangle(left, top, w, h);
        let _ = context.fill();
    }
    context.set_source_rgb(1.0, 1.0, 1.0);
    context.set_font_size(14.0);
    let label = format!("Native preview test {width} x {height}");
    if let Ok(extents) = context.text_extents(&label) {
        context.move_to(x + (width - extents.width()) / 2.0, y + height / 2.0 + cell);
        let _ = context.show_text(&label);
    }
    context.restore().ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an isolated graphical display, such as xvfb-run"]
    fn surface_linux_open_keeps_the_webview_two_levels_under_the_window() {
        gtk::init().unwrap();
        // the window, its default box and the webview as the runtime builds them
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
        window.add(&container);
        let webview = webkit2gtk::WebView::new();
        container.pack_start(&webview, true, true, 0);

        // a box that holds more than the webview is left as it is
        let menu = gtk::MenuBar::new();
        container.pack_start(&menu, false, false, 0);
        assert!(open(&webview, None).is_err());
        assert_eq!(
            webview.parent(),
            Some(container.clone().upcast::<gtk::Widget>())
        );
        container.remove(&menu);

        open(&webview, None).unwrap();
        let overlay = webview.parent().unwrap();
        assert!(overlay.is::<gtk::Overlay>());
        // the runtime's resize handler unwraps this as the window on every left press
        assert_eq!(overlay.parent(), Some(window.upcast::<gtk::Widget>()));
    }
}
