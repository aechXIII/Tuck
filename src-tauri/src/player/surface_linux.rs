//! The preview surface on Linux. The runtime builds the webview into the window's default box and
//! expects that box to stay the window's child, so the box stays where it is: an overlay takes the
//! webview's place inside it, the native picture is the overlay's base layer and the webview is
//! the layer above, with a transparent background. Wry accepts any container as the webview's
//! parent; only a fixed-position parent changes its behavior, and an overlay is not one.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::cairo;
use gtk::glib::Propagation;
use gtk::prelude::*;
use webkit2gtk::WebViewExt;

use super::Viewport;

// x, y, width and height in the area's own (logical) pixels
type Picture = (f64, f64, f64, f64);

struct Surface {
    area: gtk::DrawingArea,
    // shared with the draw handler; none while there is no picture
    picture: Rc<RefCell<Option<Picture>>>,
}

// GTK objects live and are used only on the main thread
thread_local! {
    static SURFACE: RefCell<Option<Surface>> = const { RefCell::new(None) };
}

/// Puts the surface under `webview`. Must run on the main thread.
pub fn open(webview: &webkit2gtk::WebView) -> Result<(), &'static str> {
    if SURFACE.with(|cell| cell.borrow().is_some()) {
        return Ok(());
    }
    let parent = webview
        .parent()
        .ok_or("The webview has no container yet.")?;
    let container = parent
        .downcast::<gtk::Box>()
        .map_err(|_| "The webview is not in the window's default box.")?;
    let slot = container
        .children()
        .iter()
        .position(|child| child == webview.upcast_ref::<gtk::Widget>())
        .ok_or("The webview is not in the window's default box.")?;

    let picture = Rc::new(RefCell::new(None));
    let area = gtk::DrawingArea::new();
    let drawn = picture.clone();
    area.connect_draw(move |_, context| {
        if let Some(rect) = *drawn.borrow() {
            paint_test_picture(context, rect);
        }
        Propagation::Stop
    });

    let overlay = gtk::Overlay::new();
    overlay.add(&area);
    // the local reference keeps the webview alive while it has no parent
    let webview = webview.clone();
    container.remove(&webview);
    overlay.add_overlay(&webview);
    overlay.set_overlay_pass_through(&webview, false);
    container.pack_start(&overlay, true, true, 0);
    container.reorder_child(&overlay, slot as i32);
    webview.set_background_color(&gtk::gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));
    overlay.show_all();
    webview.grab_focus();

    SURFACE.with(|cell| *cell.borrow_mut() = Some(Surface { area, picture }));
    Ok(())
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
        area.queue_draw();
    });
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
