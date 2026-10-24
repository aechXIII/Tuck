//! Keeps the main window's size, place and maximized state between launches.
//!
//! The window starts hidden (`visible: false` in tauri.conf.json), is placed here and then
//! shown, so it never jumps from the default size. Full screen is never restored: full screen
//! belongs to the player's stage, so the window comes back at its normal or maximized size.
//! The state lives with the shell rather than in the backend's settings because the window
//! is placed before the backend has started.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

use crate::commands::desktop::{MIN_LAYOUT_HEIGHT, MIN_LAYOUT_WIDTH};

const FILE_NAME: &str = "window-state.json";
const FORMAT_VERSION: u32 = 1;

/// Where a window sits, in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    /// the outer top-left corner, or `None` where the desktop doesn't share it (Wayland)
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// the inner size
    pub width: u32,
    pub height: u32,
    /// the display scale the size was measured at, so it keeps its logical size on another display
    pub scale: f64,
}

impl Bounds {
    fn position(&self) -> Option<(i32, i32)> {
        Some((self.x?, self.y?))
    }

    fn is_valid(&self) -> bool {
        // `abs` overflows on i32::MIN, which a damaged file can hold
        let coordinate = |value: Option<i32>| value.is_none_or(|v| v.unsigned_abs() <= 100_000);
        (1..=32_768).contains(&self.width)
            && (1..=32_768).contains(&self.height)
            && self.scale.is_finite()
            && (0.25..=8.0).contains(&self.scale)
            && coordinate(self.x)
            && coordinate(self.y)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedWindow {
    pub version: u32,
    /// the normal (not maximized) bounds, which a maximized window returns to
    pub bounds: Bounds,
    pub maximized: bool,
}

impl SavedWindow {
    fn new(bounds: Bounds, maximized: bool) -> Self {
        Self {
            version: FORMAT_VERSION,
            bounds,
            maximized,
        }
    }
}

/// A display's usable area (without taskbars and panels), in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub width: u32,
    pub height: u32,
    /// `None` leaves the place to the desktop
    pub position: Option<(i32, i32)>,
    pub maximized: bool,
    /// the scale of the display the window goes on
    pub scale: f64,
}

impl Placement {
    fn bounds(&self) -> Bounds {
        Bounds {
            x: self.position.map(|(x, _)| x),
            y: self.position.map(|(_, y)| y),
            width: self.width,
            height: self.height,
            scale: self.scale,
        }
    }
}

pub fn parse_saved(text: &str) -> Option<SavedWindow> {
    let saved: SavedWindow = serde_json::from_str(text).ok()?;
    (saved.version == FORMAT_VERSION && saved.bounds.is_valid()).then_some(saved)
}

fn overlap(x: i32, y: i32, width: u32, height: u32, area: &Area) -> i64 {
    let span = |start: i32, length: u32, area_start: i32, area_length: u32| {
        let end = (i64::from(start) + i64::from(length))
            .min(i64::from(area_start) + i64::from(area_length));
        (end - i64::from(start.max(area_start))).max(0)
    };
    span(x, width, area.x, area.width) * span(y, height, area.y, area.height)
}

// moves a window of `size` into the area along one axis; the start wins when it can't fit
fn clamp_axis(position: i32, start: i32, length: u32, size: u32) -> i32 {
    let last = i64::from(start) + i64::from(length) - i64::from(size);
    i64::from(position).clamp(i64::from(start), last.max(i64::from(start))) as i32
}

/// Fits a saved window onto the displays there are now.
///
/// `displays` lists the primary display first. `frame` is the outer size minus the inner size.
/// The window goes back on the display it overlaps most, moved fully into its usable area;
/// when it overlaps none (that display was unplugged), the desktop places it. The size keeps
/// its logical size, never drops below the layout's minimum and never exceeds the display.
pub fn plan_restore(
    saved: &SavedWindow,
    displays: &[Area],
    frame: (u32, u32),
    min_logical: (f64, f64),
    positions: bool,
) -> Placement {
    let bounds = saved.bounds;
    let saved_rect = bounds.position().filter(|_| positions).map(|(x, y)| {
        (
            x,
            y,
            bounds.width.saturating_add(frame.0),
            bounds.height.saturating_add(frame.1),
        )
    });
    let home = saved_rect.and_then(|(x, y, width, height)| {
        displays
            .iter()
            .map(|area| (overlap(x, y, width, height, area), area))
            .filter(|(shared, _)| *shared > 0)
            .max_by_key(|(shared, _)| *shared)
            .map(|(_, area)| *area)
    });
    let area = home.or_else(|| displays.first().copied());
    let scale = area.map_or(bounds.scale, |area| area.scale);
    let fit = |saved: u32, min_logical: f64, available: Option<u32>| -> u32 {
        let wanted = (f64::from(saved) * scale / bounds.scale).round();
        let min = (min_logical * scale).ceil();
        let size = match available {
            Some(available) => {
                let available = f64::from(available.max(1));
                wanted.min(available).max(min.min(available))
            }
            None => wanted.max(min),
        };
        size as u32
    };
    let width = fit(
        bounds.width,
        min_logical.0,
        area.map(|area| area.width.saturating_sub(frame.0)),
    );
    let height = fit(
        bounds.height,
        min_logical.1,
        area.map(|area| area.height.saturating_sub(frame.1)),
    );
    let position = match (home, saved_rect) {
        (Some(area), Some((x, y, _, _))) => Some((
            clamp_axis(x, area.x, area.width, width.saturating_add(frame.0)),
            clamp_axis(y, area.y, area.height, height.saturating_add(frame.1)),
        )),
        _ => None,
    };
    Placement {
        width,
        height,
        position,
        maximized: saved.maximized,
        scale,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Normal,
    Maximized,
    Fullscreen,
    Minimized,
}

/// Follows the window's normal bounds through its move and resize events.
///
/// Desktops report the maximized or full screen geometry before or after the window says it
/// is maximized, depending on the platform and on who maximized it. So the latest normal
/// bounds stay pending until the next move confirms them, and a pending value that already
/// matches the maximized geometry is dropped instead of saved.
#[derive(Debug)]
pub struct Tracker {
    saved: SavedWindow,
    pending: Option<Bounds>,
}

// a normal window can share the maximized place (resized in the work area's corner) or size,
// so only both together mark the maximized geometry; without positions the size alone decides
fn is_transition(pending: &Bounds, live: &Bounds) -> bool {
    let same_place = pending.position() == live.position();
    let same_size = pending.width == live.width && pending.height == live.height;
    same_place && same_size
}

impl Tracker {
    pub fn new(start: SavedWindow) -> Self {
        Self {
            saved: start,
            pending: None,
        }
    }

    fn commit(&mut self, bounds: Bounds) {
        let previous = self.saved.bounds;
        // where the desktop hides positions, keep the place from a session that had them
        self.saved.bounds = Bounds {
            x: bounds.x.or(previous.x),
            y: bounds.y.or(previous.y),
            ..bounds
        };
    }

    /// A move (`moved`) or resize event, with the window's shape and bounds read right now.
    pub fn observe(&mut self, shape: Shape, live: Bounds, moved: bool) {
        match shape {
            Shape::Minimized => {}
            Shape::Normal => {
                if moved {
                    if let Some(pending) = self.pending.take() {
                        self.commit(pending);
                    }
                }
                self.pending = Some(live);
                self.saved.maximized = false;
            }
            Shape::Maximized | Shape::Fullscreen => {
                if let Some(pending) = self.pending.take() {
                    if !is_transition(&pending, &live) {
                        self.commit(pending);
                    }
                }
                // full screen keeps whatever the window returns to when it leaves
                if shape == Shape::Maximized {
                    self.saved.maximized = true;
                }
            }
        }
    }

    /// The window is about to close: a normal window's current bounds are final.
    pub fn settle(&mut self, shape: Shape, live: Bounds) {
        if shape == Shape::Normal {
            self.pending = None;
            self.commit(live);
            self.saved.maximized = false;
        } else {
            self.observe(shape, live, false);
        }
    }

    /// The state to save now. It leaves the tracker as it was, so a save while the window
    /// stays open (a cancelled close) doesn't change what it saves later.
    pub fn snapshot(&self) -> SavedWindow {
        let mut last = Self::new(self.saved);
        if let Some(pending) = self.pending {
            last.commit(pending);
        }
        last.saved
    }
}

pub struct WindowMemory {
    tracker: Mutex<Tracker>,
    file: Option<PathBuf>,
    positions: bool,
}

#[cfg(target_os = "linux")]
fn desktop_shares_positions() -> bool {
    use gtk::glib::prelude::ObjectExt;
    // a Wayland compositor neither reports nor accepts window positions
    gtk::gdk::Display::default().is_none_or(|display| display.type_().name() != "GdkWaylandDisplay")
}

#[cfg(not(target_os = "linux"))]
fn desktop_shares_positions() -> bool {
    true
}

#[cfg(target_os = "linux")]
fn desktop_fullscreen(window: &tauri::Window) -> bool {
    use gtk::prelude::*;
    // the desktop can make the window full screen by itself, which Tauri doesn't track
    window
        .gtk_window()
        .ok()
        .and_then(|window| window.window())
        .is_some_and(|window| window.state().contains(gtk::gdk::WindowState::FULLSCREEN))
}

#[cfg(not(target_os = "linux"))]
fn desktop_fullscreen(_window: &tauri::Window) -> bool {
    false
}

fn shape(window: &tauri::Window) -> Shape {
    if window.is_minimized().unwrap_or(false) {
        Shape::Minimized
    } else if window.is_fullscreen().unwrap_or(false) || desktop_fullscreen(window) {
        Shape::Fullscreen
    } else if window.is_maximized().unwrap_or(false) {
        Shape::Maximized
    } else {
        Shape::Normal
    }
}

fn live_bounds(window: &tauri::Window, positions: bool) -> Option<Bounds> {
    let size = window.inner_size().ok()?;
    let scale = window.scale_factor().ok()?;
    let position = positions.then(|| window.outer_position().ok()).flatten();
    let bounds = Bounds {
        x: position.map(|p| p.x),
        y: position.map(|p| p.y),
        width: size.width,
        height: size.height,
        scale,
    };
    bounds.is_valid().then_some(bounds)
}

fn display_areas(window: &tauri::WebviewWindow) -> Vec<Area> {
    let area = |monitor: &tauri::Monitor| {
        let work = monitor.work_area();
        Area {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
            scale: monitor.scale_factor(),
        }
    };
    let mut areas: Vec<Area> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(area)
        .collect();
    if let Ok(Some(primary)) = window.primary_monitor() {
        let primary = area(&primary);
        areas.retain(|other| *other != primary);
        areas.insert(0, primary);
    }
    areas
}

fn read_saved(file: &Path) -> Option<SavedWindow> {
    let text = std::fs::read_to_string(file).ok()?;
    let saved = parse_saved(&text);
    if saved.is_none() {
        eprintln!("ignoring an unreadable saved window state");
    }
    saved
}

fn write_saved(file: &Path, saved: &SavedWindow) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_vec_pretty(saved).map_err(std::io::Error::other)?;
    // a crash while writing leaves the previous file whole
    let temporary = file.with_extension("json.tmp");
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, file)
}

fn place(window: &tauri::WebviewWindow, placement: &Placement) -> tauri::Result<()> {
    window.set_size(PhysicalSize::new(placement.width, placement.height))?;
    if let Some((x, y)) = placement.position {
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

/// Puts the hidden main window back where it was last time, starts following it and shows it.
pub fn restore_and_show(window: &tauri::WebviewWindow) {
    let file = window
        .app_handle()
        .path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(FILE_NAME));
    let positions = desktop_shares_positions();
    let saved = file.as_deref().and_then(read_saved);
    let placement = saved.map(|saved| {
        let frame = match (window.outer_size(), window.inner_size()) {
            (Ok(outer), Ok(inner)) => (
                outer.width.saturating_sub(inner.width),
                outer.height.saturating_sub(inner.height),
            ),
            _ => (0, 0),
        };
        plan_restore(
            &saved,
            &display_areas(window),
            frame,
            (MIN_LAYOUT_WIDTH, MIN_LAYOUT_HEIGHT),
            positions,
        )
    });
    // the normal bounds are known before maximizing; a hidden window may not report them yet
    let start = match (saved, placement) {
        (Some(saved), Some(placement)) => {
            let bounds = placement.bounds();
            // a place that couldn't be used now (Wayland, an unplugged display) stays for later
            let bounds = Bounds {
                x: bounds.x.or(saved.bounds.x),
                y: bounds.y.or(saved.bounds.y),
                ..bounds
            };
            Some(SavedWindow::new(bounds, placement.maximized))
        }
        _ => live_bounds(&window.as_ref().window(), positions)
            .map(|bounds| SavedWindow::new(bounds, false)),
    };
    if let Some(start) = start {
        window.manage(WindowMemory {
            tracker: Mutex::new(Tracker::new(start)),
            file,
            positions,
        });
    }
    if let Some(placement) = placement {
        let restored = place(window, &placement).and_then(|()| {
            if placement.maximized {
                window.maximize()
            } else {
                Ok(())
            }
        });
        if let Err(error) = restored {
            eprintln!("could not restore the window's size and place: {error}");
        }
    }
    if let Err(error) = window.show() {
        eprintln!("could not show the window: {error}");
    }
}

fn follow(window: &tauri::Window, update: impl FnOnce(&mut Tracker, Shape, Bounds)) {
    let Some(memory) = window.try_state::<WindowMemory>() else {
        return;
    };
    let Some(live) = live_bounds(window, memory.positions) else {
        return;
    };
    let shape = shape(window);
    let Ok(mut tracker) = memory.tracker.lock() else {
        return;
    };
    update(&mut tracker, shape, live);
}

/// Call for every move and resize of the main window.
pub fn observe(window: &tauri::Window, moved: bool) {
    follow(window, |tracker, shape, live| {
        tracker.observe(shape, live, moved)
    });
}

/// Call when the main window is asked to close, while its state can still be read.
pub fn settle(window: &tauri::Window) {
    follow(window, |tracker, shape, live| tracker.settle(shape, live));
}

/// Writes the window's last state. Call it when the window is asked to close, before an update
/// installs (which ends the app without an exit event) and as the app exits. Saving again is
/// harmless, and the window is still followed afterwards.
pub fn save(app: &tauri::AppHandle) {
    let Some(memory) = app.try_state::<WindowMemory>() else {
        return;
    };
    let Some(file) = memory.file.as_deref() else {
        return;
    };
    // held while writing, so saves from two threads can't mix their files
    let Ok(tracker) = memory.tracker.lock() else {
        return;
    };
    if let Err(error) = write_saved(file, &tracker.snapshot()) {
        eprintln!("could not save the window's size and place: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: (f64, f64) = (960.0, 640.0);

    fn bounds(x: i32, y: i32, width: u32, height: u32) -> Bounds {
        Bounds {
            x: Some(x),
            y: Some(y),
            width,
            height,
            scale: 1.0,
        }
    }

    fn saved(bounds: Bounds, maximized: bool) -> SavedWindow {
        SavedWindow::new(bounds, maximized)
    }

    fn display(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Area {
        Area {
            x,
            y,
            width,
            height,
            scale,
        }
    }

    #[test]
    fn a_window_that_fits_comes_back_exactly() {
        let placement = plan_restore(
            &saved(bounds(200, 120, 1400, 900), false),
            &[display(0, 0, 1920, 1040, 1.0)],
            (0, 0),
            MIN,
            true,
        );
        assert_eq!(
            placement,
            Placement {
                width: 1400,
                height: 900,
                position: Some((200, 120)),
                maximized: false,
                scale: 1.0,
            }
        );
    }

    #[test]
    fn a_window_on_an_unplugged_display_is_placed_by_the_desktop() {
        let displays = [display(0, 0, 1920, 1040, 1.0)];
        let placement = plan_restore(
            &saved(bounds(2200, 100, 1240, 800), true),
            &displays,
            (0, 0),
            MIN,
            true,
        );
        assert_eq!(placement.position, None);
        assert_eq!((placement.width, placement.height), (1240, 800));
        assert!(placement.maximized);
    }

    #[test]
    fn a_window_partly_off_screen_moves_fully_onto_its_display() {
        let displays = [
            display(0, 0, 1920, 1040, 1.0),
            display(1920, 0, 2560, 1400, 1.0),
        ];
        // mostly on the second display, hanging off its right and bottom edges
        let placement = plan_restore(
            &saved(bounds(3900, 1000, 1240, 800), false),
            &displays,
            (0, 0),
            MIN,
            true,
        );
        assert_eq!(placement.position, Some((1920 + 2560 - 1240, 1400 - 800)));
        // above the top edge, where the title bar would be out of reach
        let placement = plan_restore(
            &saved(bounds(100, -300, 1240, 800), false),
            &displays,
            (0, 0),
            MIN,
            true,
        );
        assert_eq!(placement.position, Some((100, 0)));
    }

    #[test]
    fn the_size_never_drops_below_the_minimum_or_grows_past_the_display() {
        let displays = [display(0, 0, 1920, 1040, 1.0)];
        let small = plan_restore(
            &saved(bounds(10, 10, 400, 300), false),
            &displays,
            (0, 0),
            MIN,
            true,
        );
        assert_eq!((small.width, small.height), (960, 640));
        let large = plan_restore(
            &saved(bounds(0, 0, 3000, 2000), false),
            &displays,
            (16, 39),
            MIN,
            true,
        );
        assert_eq!((large.width, large.height), (1920 - 16, 1040 - 39));
        assert_eq!(large.position, Some((0, 0)));
    }

    #[test]
    fn a_display_smaller_than_the_minimum_gets_the_whole_display() {
        let placement = plan_restore(
            &saved(bounds(0, 0, 1240, 800), false),
            &[display(0, 0, 900, 600, 1.0)],
            (0, 0),
            MIN,
            true,
        );
        assert_eq!((placement.width, placement.height), (900, 600));
    }

    #[test]
    fn the_size_keeps_its_logical_size_on_a_display_with_another_scale() {
        // saved at 100%, now on a 200% display
        let placement = plan_restore(
            &saved(bounds(100, 100, 1240, 800), false),
            &[display(0, 0, 3840, 2080, 2.0)],
            (0, 0),
            MIN,
            true,
        );
        assert_eq!((placement.width, placement.height), (2480, 1600));
        // saved at 200%, now on a 100% display: half the pixels, still above the minimum
        let saved_hidpi = Bounds {
            scale: 2.0,
            ..bounds(100, 100, 2480, 1600)
        };
        let placement = plan_restore(
            &saved(saved_hidpi, false),
            &[display(0, 0, 1920, 1040, 1.0)],
            (0, 0),
            MIN,
            true,
        );
        assert_eq!((placement.width, placement.height), (1240, 800));
    }

    #[test]
    fn without_positions_only_the_size_is_restored() {
        let placement = plan_restore(
            &saved(bounds(300, 200, 1400, 900), false),
            &[display(0, 0, 1920, 1040, 1.0)],
            (0, 0),
            MIN,
            false,
        );
        assert_eq!(placement.position, None);
        assert_eq!((placement.width, placement.height), (1400, 900));
    }

    #[test]
    fn without_display_information_the_minimum_still_holds() {
        let placement = plan_restore(
            &saved(bounds(0, 0, 500, 500), false),
            &[],
            (0, 0),
            MIN,
            true,
        );
        assert_eq!(
            (placement.width, placement.height, placement.position),
            (960, 640, None)
        );
    }

    #[test]
    fn saved_state_rejects_other_versions_and_impossible_values() {
        let good = serde_json::to_string(&saved(bounds(10, 20, 1240, 800), true)).unwrap();
        assert_eq!(
            parse_saved(&good),
            Some(saved(bounds(10, 20, 1240, 800), true))
        );
        for bad in [
            good.replace("\"version\":1", "\"version\":2"),
            good.replace("\"width\":1240", "\"width\":0"),
            good.replace("\"scale\":1.0", "\"scale\":0.0"),
            good.replace("\"x\":10", "\"x\":900000"),
            good.replace("\"x\":10", "\"x\":-2147483648"),
            "{".to_owned(),
            String::new(),
        ] {
            assert_eq!(parse_saved(&bad), None, "{bad}");
        }
        let wayland = good
            .replace("\"x\":10", "\"x\":null")
            .replace("\"y\":20", "\"y\":null");
        assert_eq!(parse_saved(&wayland).unwrap().bounds.position(), None);
    }

    #[test]
    fn saving_replaces_the_file_whole() {
        let directory = std::env::temp_dir().join(format!(
            "tuck-window-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = directory.join("nested").join(FILE_NAME);
        let first = saved(bounds(1, 2, 1000, 700), false);
        let second = saved(bounds(3, 4, 1100, 750), true);
        write_saved(&file, &first).unwrap();
        write_saved(&file, &second).unwrap();
        assert_eq!(read_saved(&file), Some(second));
        assert!(!file.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    const MAXIMIZED: Bounds = Bounds {
        x: Some(-8),
        y: Some(-8),
        width: 1936,
        height: 1056,
        scale: 1.0,
    };

    #[test]
    fn maximizing_keeps_the_last_normal_bounds_when_the_flag_comes_first() {
        // Tuck's own maximize button: the window says it is maximized before it moves
        let mut tracker = Tracker::new(saved(bounds(100, 100, 1240, 800), false));
        tracker.observe(Shape::Normal, bounds(150, 120, 1240, 800), true);
        tracker.observe(Shape::Normal, bounds(160, 130, 1240, 800), true);
        tracker.observe(Shape::Maximized, MAXIMIZED, true);
        tracker.observe(Shape::Maximized, MAXIMIZED, false);
        assert_eq!(tracker.snapshot(), saved(bounds(160, 130, 1240, 800), true));
    }

    #[test]
    fn maximizing_drops_the_maximized_geometry_when_the_move_comes_first() {
        // the desktop maximizes (snapping, a key): the move arrives while still normal
        let mut tracker = Tracker::new(saved(bounds(100, 100, 1240, 800), false));
        tracker.observe(Shape::Normal, bounds(160, 130, 1240, 800), true);
        tracker.observe(Shape::Normal, MAXIMIZED, true);
        tracker.observe(Shape::Normal, MAXIMIZED, false);
        tracker.observe(Shape::Maximized, MAXIMIZED, false);
        assert_eq!(tracker.snapshot(), saved(bounds(160, 130, 1240, 800), true));
    }

    #[test]
    fn maximizing_keeps_a_new_size_at_the_maximized_place() {
        // a window in the work area's corner, resized by its far edges, so it never moved
        let corner =
            |width, height| bounds(MAXIMIZED.x.unwrap(), MAXIMIZED.y.unwrap(), width, height);
        let mut tracker = Tracker::new(saved(corner(1240, 800), false));
        tracker.observe(Shape::Normal, corner(1400, 900), false);
        tracker.observe(Shape::Maximized, MAXIMIZED, true);
        tracker.observe(Shape::Maximized, MAXIMIZED, false);
        assert_eq!(tracker.snapshot(), saved(corner(1400, 900), true));
    }

    #[test]
    fn saving_while_the_window_stays_open_changes_nothing_that_follows() {
        // a save before the desktop's maximize has finished (a close the page then cancelled)
        let mut tracker = Tracker::new(saved(bounds(100, 100, 1240, 800), false));
        tracker.observe(Shape::Normal, bounds(160, 130, 1240, 800), true);
        tracker.observe(Shape::Normal, MAXIMIZED, true);
        let _ = tracker.snapshot();
        tracker.observe(Shape::Maximized, MAXIMIZED, false);
        assert_eq!(tracker.snapshot(), saved(bounds(160, 130, 1240, 800), true));
        // the window is followed as before once the close is cancelled
        tracker.observe(Shape::Normal, bounds(160, 130, 1240, 800), false);
        tracker.observe(Shape::Normal, bounds(300, 200, 1240, 800), true);
        tracker.settle(Shape::Normal, bounds(300, 200, 1240, 800));
        assert_eq!(
            tracker.snapshot(),
            saved(bounds(300, 200, 1240, 800), false)
        );
    }

    #[test]
    fn full_screen_is_never_saved_and_keeps_the_maximized_state_beneath_it() {
        let mut tracker = Tracker::new(saved(bounds(100, 100, 1240, 800), true));
        let screen = bounds(0, 0, 1920, 1080);
        tracker.observe(Shape::Fullscreen, screen, true);
        tracker.observe(Shape::Fullscreen, screen, false);
        tracker.settle(Shape::Fullscreen, screen);
        assert_eq!(tracker.snapshot(), saved(bounds(100, 100, 1240, 800), true));
    }

    #[test]
    fn closing_a_normal_window_saves_where_it_is_now() {
        let mut tracker = Tracker::new(saved(bounds(100, 100, 1240, 800), true));
        tracker.observe(Shape::Normal, bounds(100, 100, 1240, 800), false);
        tracker.settle(Shape::Normal, bounds(400, 300, 1300, 850));
        assert_eq!(
            tracker.snapshot(),
            saved(bounds(400, 300, 1300, 850), false)
        );
    }

    #[test]
    fn minimizing_changes_nothing() {
        let mut tracker = Tracker::new(saved(bounds(100, 100, 1240, 800), false));
        tracker.observe(Shape::Minimized, bounds(-32000, -32000, 160, 28), true);
        tracker.settle(Shape::Minimized, bounds(-32000, -32000, 160, 28));
        assert_eq!(
            tracker.snapshot(),
            saved(bounds(100, 100, 1240, 800), false)
        );
    }

    #[test]
    fn without_positions_the_size_is_followed_and_the_old_place_kept() {
        let mut tracker = Tracker::new(saved(bounds(300, 200, 1240, 800), false));
        let unplaced = |width, height| Bounds {
            x: None,
            y: None,
            width,
            height,
            scale: 1.0,
        };
        // GTK reports every configure as a move and a resize, here at no position
        let configure = |tracker: &mut Tracker, shape, live| {
            tracker.observe(shape, live, true);
            tracker.observe(shape, live, false);
        };
        configure(&mut tracker, Shape::Normal, unplaced(1300, 860));
        configure(&mut tracker, Shape::Normal, unplaced(1920, 1080));
        configure(&mut tracker, Shape::Maximized, unplaced(1920, 1080));
        assert_eq!(
            tracker.snapshot(),
            saved(
                Bounds {
                    width: 1300,
                    height: 860,
                    ..bounds(300, 200, 0, 0)
                },
                true
            )
        );
    }
}
