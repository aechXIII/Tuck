//! Native preview player, Hardware playback in Settings. The page leaves a transparent hole where
//! the picture belongs and the desktop shell draws below it, so the page's own controls (crop
//! handles, menus, dialogs) stay on top without any z-order tricks. The engine owns the playback
//! clock and seek rules; the native player library decodes and draws.

use std::sync::OnceLock;

use serde::Deserialize;

pub mod engine;
pub mod library;
pub mod preference;
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

/// What this run asks for, read once before the window system starts: the developer switch
/// `TUCK_NATIVE_PREVIEW` when it is set, otherwise the user's Hardware playback choice.
pub fn requested_mode() -> PreviewMode {
    static MODE: OnceLock<PreviewMode> = OnceLock::new();
    *MODE.get_or_init(|| {
        requested(
            std::env::var("TUCK_NATIVE_PREVIEW").ok().as_deref(),
            preference::hardware_playback_at_start,
        )
    })
}

fn requested(switch: Option<&str>, hardware_playback: impl FnOnce() -> bool) -> PreviewMode {
    match switch {
        Some(value) => PreviewMode::from_switch(Some(value)),
        None if hardware_playback() => PreviewMode::Player,
        None => PreviewMode::Off,
    }
}

/// How the preview plays in this run, and why it uses the built-in player when the native
/// player was asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewChoice {
    pub mode: PreviewMode,
    /// why the native player library could not be used; empty when it was not asked for or loaded
    pub fallback: String,
}

/// Decided once, after the packaged resource folder is known: the native player only when its
/// library loads, so a missing or mismatched library leaves the built-in player instead of a
/// preview that can't open anything.
pub fn preview_choice() -> &'static PreviewChoice {
    static CHOICE: OnceLock<PreviewChoice> = OnceLock::new();
    CHOICE.get_or_init(|| choose(requested_mode(), library::check))
}

fn choose(
    requested: PreviewMode,
    check_library: impl FnOnce() -> Result<(), String>,
) -> PreviewChoice {
    if requested != PreviewMode::Player {
        return PreviewChoice {
            mode: requested,
            fallback: String::new(),
        };
    }
    match check_library() {
        Ok(()) => PreviewChoice {
            mode: PreviewMode::Player,
            fallback: String::new(),
        },
        Err(reason) => PreviewChoice {
            mode: PreviewMode::Off,
            fallback: reason,
        },
    }
}

pub fn preview_mode() -> PreviewMode {
    preview_choice().mode
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

/// Which part of the picture fills the preview and how it is turned: the editor's crop, turn and
/// flips. The part is in shares of the picture as the file's own rotation shows it.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PictureView {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// quarter turns to the right on top of the file's own rotation
    pub quarter_turns: u8,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    /// fills the preview even where that changes the picture's shape, as the Stretch sizing does
    pub stretch: bool,
}

impl Default for PictureView {
    fn default() -> Self {
        PictureView {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            quarter_turns: 0,
            flip_horizontal: false,
            flip_vertical: false,
            stretch: false,
        }
    }
}

impl PictureView {
    // the page rounds its shares, so they may end a hair past the picture's edge (view.h agrees)
    const SLACK: f64 = 1e-6;

    pub fn validate(self) -> Result<Self, &'static str> {
        let share = |value: f64| value.is_finite() && value >= 0.0;
        let inside = share(self.x)
            && share(self.y)
            && share(self.width)
            && share(self.height)
            && self.width > 0.0
            && self.height > 0.0
            && self.x + self.width <= 1.0 + Self::SLACK
            && self.y + self.height <= 1.0 + Self::SLACK;
        if !inside || self.quarter_turns > 3 {
            return Err("The preview's crop or turn is out of range.");
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_must_stay_inside_the_picture() {
        let view = |x: f64, width: f64, quarter_turns: u8| PictureView {
            x,
            width,
            quarter_turns,
            ..PictureView::default()
        };
        assert!(PictureView::default().validate().is_ok());
        assert!(view(0.25, 0.5, 3).validate().is_ok());
        assert!(
            view(0.5, 0.5000001, 0).validate().is_ok(),
            "rounding past the edge is fine"
        );
        assert!(view(0.6, 0.5, 0).validate().is_err());
        assert!(view(0.0, 0.0, 0).validate().is_err());
        assert!(view(-0.1, 0.5, 0).validate().is_err());
        assert!(view(f64::NAN, 0.5, 0).validate().is_err());
        assert!(view(0.0, 1.0, 4).validate().is_err());
    }

    #[test]
    fn views_parse_strictly_from_the_page() {
        let parse = |json: &str| serde_json::from_str::<PictureView>(json);
        let view = parse(
            r#"{"x":0.1,"y":0,"width":0.5,"height":1,"quarterTurns":1,"flipHorizontal":true,"flipVertical":false,"stretch":false}"#,
        )
        .expect("a full view");
        assert_eq!(view.quarter_turns, 1);
        assert!(view.flip_horizontal);
        assert!(parse(r#"{"x":0,"y":0,"width":1,"height":1}"#).is_err());
        assert!(parse(
            r#"{"x":0,"y":0,"width":1,"height":1,"quarterTurns":-1,"flipHorizontal":false,"flipVertical":false,"stretch":false}"#
        )
        .is_err());
    }

    fn viewport(x: f64, y: f64, width: f64, height: f64) -> Viewport {
        Viewport {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn hardware_playback_picks_the_native_player_unless_the_switch_says_otherwise() {
        assert_eq!(requested(None, || true), PreviewMode::Player);
        assert_eq!(requested(None, || false), PreviewMode::Off);
        assert_eq!(requested(Some("off"), || unreachable!()), PreviewMode::Off);
        assert_eq!(
            requested(Some("engine"), || unreachable!()),
            PreviewMode::Engine
        );
        assert_eq!(
            requested(Some("player"), || unreachable!()),
            PreviewMode::Player
        );
    }

    #[test]
    fn a_library_that_can_not_load_leaves_the_built_in_player() {
        let missing = choose(PreviewMode::Player, || {
            Err("The native player library is missing.".to_string())
        });
        assert_eq!(missing.mode, PreviewMode::Off);
        assert_eq!(missing.fallback, "The native player library is missing.");
        let loaded = choose(PreviewMode::Player, || Ok(()));
        assert_eq!(
            (loaded.mode, loaded.fallback.as_str()),
            (PreviewMode::Player, "")
        );
        // nothing else needs the library
        let engine = choose(PreviewMode::Engine, || unreachable!());
        assert_eq!(engine.mode, PreviewMode::Engine);
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
