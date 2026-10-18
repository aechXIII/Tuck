//! Native preview player. The page leaves a transparent hole where the picture belongs and the
//! desktop shell draws below it, so the page's own controls (crop handles, menus, dialogs) stay on
//! top without any z-order tricks. The engine owns the playback clock and seek rules; it does not
//! decode yet, so the surface still shows a test picture.

use std::sync::OnceLock;

use serde::Deserialize;

pub mod engine;
pub mod library;
#[cfg(target_os = "linux")]
pub mod surface_linux;
#[cfg(windows)]
pub mod surface_windows;

/// What the native preview can do in this run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewMode {
    Off,
    /// draws a test picture in place of the video, for checking the surface itself
    Surface,
    /// the surface plus the native engine driving playback, still without decoding
    Engine,
    /// the native player library decoding and drawing the video
    Player,
}

impl PreviewMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PreviewMode::Off => "off",
            PreviewMode::Surface => "surface",
            PreviewMode::Engine => "engine",
            PreviewMode::Player => "player",
        }
    }

    fn from_switch(value: Option<&str>) -> Self {
        match value {
            Some("surface") => PreviewMode::Surface,
            Some("engine") => PreviewMode::Engine,
            Some("player") => PreviewMode::Player,
            _ => PreviewMode::Off,
        }
    }
}

/// Read once: a developer switch until the player plays real video and gets a setting.
pub fn preview_mode() -> PreviewMode {
    static MODE: OnceLock<PreviewMode> = OnceLock::new();
    *MODE.get_or_init(|| {
        PreviewMode::from_switch(std::env::var("TUCK_NATIVE_PREVIEW").ok().as_deref())
    })
}

/// Where the picture is, in CSS pixels from the page's top left corner.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

const MAX_CSS_PIXELS: f64 = 16_384.0;

impl Viewport {
    // the page is untrusted input; anything outside a window-sized box is a bug or an attack
    pub fn validate(self) -> Result<Self, &'static str> {
        let position = |value: f64| value.is_finite() && value.abs() <= MAX_CSS_PIXELS;
        let size = |value: f64| value.is_finite() && (0.0..=MAX_CSS_PIXELS).contains(&value);
        if !position(self.x) || !position(self.y) {
            return Err("The preview position is out of range.");
        }
        if !size(self.width) || !size(self.height) {
            return Err("The preview size is out of range.");
        }
        Ok(self)
    }

    pub fn is_empty(self) -> bool {
        self.width < 1.0 || self.height < 1.0
    }

    /// The picture in device pixels for `pixels_per_css`. Edges round outward: the page covers
    /// anything outside its hole, so a picture one pixel too big never shows a seam.
    pub fn device_rect(self, pixels_per_css: f64) -> (i32, i32, i32, i32) {
        let left = (self.x * pixels_per_css).floor();
        let top = (self.y * pixels_per_css).floor();
        let right = ((self.x + self.width) * pixels_per_css).ceil();
        let bottom = ((self.y + self.height) * pixels_per_css).ceil();
        (
            left as i32,
            top as i32,
            (right - left) as i32,
            (bottom - top) as i32,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewport(x: f64, y: f64, width: f64, height: f64) -> Viewport {
        Viewport {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn the_switch_only_turns_on_for_the_known_value() {
        assert_eq!(PreviewMode::from_switch(None), PreviewMode::Off);
        assert_eq!(PreviewMode::from_switch(Some("")), PreviewMode::Off);
        assert_eq!(PreviewMode::from_switch(Some("on")), PreviewMode::Off);
        assert_eq!(
            PreviewMode::from_switch(Some("surface")),
            PreviewMode::Surface
        );
        assert_eq!(
            PreviewMode::from_switch(Some("engine")),
            PreviewMode::Engine
        );
        assert_eq!(
            PreviewMode::from_switch(Some("player")),
            PreviewMode::Player
        );
        assert_eq!(PreviewMode::Engine.as_str(), "engine");
        assert_eq!(PreviewMode::Player.as_str(), "player");
        assert_eq!(PreviewMode::Surface.as_str(), "surface");
    }

    #[test]
    fn untrusted_geometry_is_rejected() {
        assert!(viewport(10.0, 20.0, 640.0, 360.0).validate().is_ok());
        assert!(viewport(0.0, 0.0, 0.0, 0.0).validate().is_ok());
        assert!(viewport(f64::NAN, 0.0, 10.0, 10.0).validate().is_err());
        assert!(viewport(0.0, f64::INFINITY, 10.0, 10.0).validate().is_err());
        assert!(viewport(0.0, 0.0, -1.0, 10.0).validate().is_err());
        assert!(viewport(0.0, 0.0, 10.0, 20_000.0).validate().is_err());
        assert!(viewport(-20_000.0, 0.0, 10.0, 10.0).validate().is_err());
    }

    #[test]
    fn device_rect_rounds_outward() {
        assert_eq!(
            viewport(10.0, 20.0, 640.0, 360.0).device_rect(1.0),
            (10, 20, 640, 360)
        );
        assert_eq!(
            viewport(10.25, 20.5, 100.5, 50.25).device_rect(1.5),
            (15, 30, 152, 77)
        );
        assert!(viewport(5.0, 5.0, 0.5, 10.0).is_empty());
        assert!(!viewport(5.0, 5.0, 1.0, 1.0).is_empty());
    }
}
