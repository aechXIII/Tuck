use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

pub const MAXIMIZED_EVENT: &str = "window-maximized";

// the page's zoom from the interface size setting; CSS pixels from the page are this many
// logical pixels, so native positions taken from the page must include it
static PAGE_ZOOM_BITS: AtomicU64 = AtomicU64::new(0x3FF0_0000_0000_0000); // 1.0

pub fn set_page_zoom(zoom: f64) {
    PAGE_ZOOM_BITS.store(zoom.to_bits(), Ordering::Relaxed);
}

/// Physical pixels per CSS pixel for a display `scale`.
pub fn css_to_physical(scale: f64) -> f64 {
    scale * f64::from_bits(PAGE_ZOOM_BITS.load(Ordering::Relaxed))
}

/// Where the HTML maximize button sits, in CSS pixels, measured from the window's right edge.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionArea {
    pub right: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct WindowChromeState {
    pub maximized: bool,
}

impl CaptionArea {
    // the page is untrusted input, so the overlay can only ever cover a small caption-sized box
    pub fn validate(self) -> Result<Self, &'static str> {
        let in_range =
            |value: f64, min: f64, max: f64| value.is_finite() && value >= min && value <= max;
        if !in_range(self.right, 0.0, 400.0) {
            return Err("The maximize button is too far from the window edge.");
        }
        if !in_range(self.width, 1.0, 120.0) || !in_range(self.height, 1.0, 80.0) {
            return Err("The maximize button size is out of range.");
        }
        Ok(self)
    }

    /// Left edge, width and height in physical pixels for a client area `client_right` wide.
    pub fn physical(self, client_right: i32, scale: f64) -> (i32, i32, i32) {
        let to_px = |css: f64| (css * scale).round() as i32;
        let width = to_px(self.width);
        let x = client_right - to_px(self.right) - width;
        (x, width, to_px(self.height))
    }
}

/// Client point for the window menu, in CSS pixels.
pub fn validate_menu_point(x: f64, y: f64) -> Result<(f64, f64), &'static str> {
    let ok = |value: f64| value.is_finite() && (0.0..=20_000.0).contains(&value);
    if ok(x) && ok(y) {
        Ok((x, y))
    } else {
        Err("The window menu position is out of range.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(right: f64, width: f64, height: f64) -> CaptionArea {
        CaptionArea {
            right,
            width,
            height,
        }
    }

    #[test]
    fn page_zoom_scales_css_pixels_with_the_display() {
        set_page_zoom(1.1);
        assert!((css_to_physical(1.5) - 1.65).abs() < 1e-9);
        set_page_zoom(1.0);
        assert!((css_to_physical(1.5) - 1.5).abs() < 1e-9);
    }

    #[test]
    fn caption_area_accepts_a_title_bar_button() {
        assert_eq!(
            area(46.0, 46.0, 40.0).validate(),
            Ok(area(46.0, 46.0, 40.0))
        );
    }

    #[test]
    fn caption_area_rejects_boxes_that_could_cover_the_page() {
        assert!(area(46.0, 600.0, 40.0).validate().is_err());
        assert!(area(46.0, 46.0, 500.0).validate().is_err());
        assert!(area(-1.0, 46.0, 40.0).validate().is_err());
        assert!(area(f64::NAN, 46.0, 40.0).validate().is_err());
        assert!(area(46.0, 0.0, 40.0).validate().is_err());
    }

    #[test]
    fn caption_area_is_measured_from_the_right_edge_in_physical_pixels() {
        // close is 46 px wide, so maximize starts 92 px from the right
        assert_eq!(area(46.0, 46.0, 40.0).physical(1240, 1.0), (1148, 46, 40));
        assert_eq!(area(46.0, 46.0, 40.0).physical(1860, 1.5), (1722, 69, 60));
    }

    #[test]
    fn menu_point_must_be_finite_and_inside_a_window() {
        assert_eq!(validate_menu_point(12.0, 40.0), Ok((12.0, 40.0)));
        assert!(validate_menu_point(f64::INFINITY, 0.0).is_err());
        assert!(validate_menu_point(-5.0, 0.0).is_err());
    }
}
