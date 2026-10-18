//! Safe owner of the C player core. The C object is not thread-safe, so every call goes through
//! one `Engine` behind the player state's mutex.

use std::ffi::c_void;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::library::{Video, VideoInfo};

#[repr(C)]
struct TuckPlayer {
    _private: [u8; 0],
}

/// The clock's status as the C core lays it out; the native player library embeds it too.
#[repr(C)]
#[derive(Default)]
pub(crate) struct RawStatus {
    monotonic_seconds: f64,
    position_seconds: f64,
    duration_seconds: f64,
    generation: u64,
    seek_request_id: u64,
    confirmed_seek_request_id: u64,
    paused: i32,
    seek_pending: i32,
    ended: i32,
}

extern "C" {
    fn tuck_player_create(duration_seconds: f64, now: f64) -> *mut TuckPlayer;
    fn tuck_player_destroy(player: *mut TuckPlayer);
    fn tuck_player_play(player: *mut TuckPlayer, now: f64);
    fn tuck_player_pause(player: *mut TuckPlayer, now: f64);
    fn tuck_player_seek(player: *mut TuckPlayer, request_id: u64, seconds: f64, now: f64) -> i32;
    fn tuck_player_frame_presented(player: *mut TuckPlayer, generation: u64, now: f64);
    fn tuck_player_status(player: *mut TuckPlayer, now: f64, status: *mut RawStatus);
}

/// What the page sees of the player. Request IDs stay below 2^53, so they are exact in JavaScript.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStatus {
    pub monotonic_seconds: f64,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub generation: u64,
    pub seek_request_id: u64,
    pub confirmed_seek_request_id: u64,
    pub paused: bool,
    pub seek_pending: bool,
    pub ended: bool,
    /// the decoder and renderer, when the native player library plays the video
    pub video: Option<VideoInfo>,
}

impl From<RawStatus> for PlayerStatus {
    fn from(raw: RawStatus) -> Self {
        PlayerStatus {
            monotonic_seconds: raw.monotonic_seconds,
            position_seconds: raw.position_seconds,
            duration_seconds: raw.duration_seconds,
            generation: raw.generation,
            seek_request_id: raw.seek_request_id,
            confirmed_seek_request_id: raw.confirmed_seek_request_id,
            paused: raw.paused != 0,
            seek_pending: raw.seek_pending != 0,
            ended: raw.ended != 0,
            video: None,
        }
    }
}

pub struct Engine {
    player: NonNull<TuckPlayer>,
    started: Instant,
}

// the C player is only ever used through `&mut Engine`, which the player state's mutex serializes
unsafe impl Send for Engine {}

impl Engine {
    /// `None` unless `duration_seconds` is positive and finite.
    pub fn open(duration_seconds: f64) -> Option<Self> {
        let started = Instant::now();
        let player = NonNull::new(unsafe { tuck_player_create(duration_seconds, 0.0) })?;
        Some(Engine { player, started })
    }

    fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    pub fn play(&mut self) {
        let now = self.now();
        unsafe { tuck_player_play(self.player.as_ptr(), now) }
    }

    pub fn pause(&mut self) {
        let now = self.now();
        unsafe { tuck_player_pause(self.player.as_ptr(), now) }
    }

    /// False when the request ID is not newer than the last one or the position is outside the
    /// video.
    pub fn seek(&mut self, request_id: u64, seconds: f64) -> bool {
        let now = self.now();
        unsafe { tuck_player_seek(self.player.as_ptr(), request_id, seconds, now) != 0 }
    }

    /// Until there is a renderer, the picture for a new position counts as shown as soon as it
    /// is asked for; a renderer reports this when its frame is actually on screen.
    pub fn present_current_frame(&mut self) {
        let generation = self.status().generation;
        let now = self.now();
        unsafe { tuck_player_frame_presented(self.player.as_ptr(), generation, now) }
    }

    pub fn status(&mut self) -> PlayerStatus {
        let now = self.now();
        let mut raw = RawStatus::default();
        unsafe { tuck_player_status(self.player.as_ptr(), now, &mut raw) };
        raw.into()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe { tuck_player_destroy(self.player.as_ptr()) }
    }
}

/// What the page asks the player to do. Seeks carry increasing request IDs from the page.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PlayerCommand {
    Play,
    Pause,
    #[serde(rename_all = "camelCase")]
    Seek {
        request_id: u64,
        seconds: f64,
    },
    /// the sound's level, 0 to 1, the same value the page gives its own video element
    Volume {
        volume: f64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlayerError {
    NotOpen,
    InvalidLength,
    /// an old or repeated request ID, or a position outside the video
    SeekRefused,
    /// a volume outside 0 to 1
    InvalidVolume,
    /// the native player library could not open the video; the text says why
    Video(String),
}

// a week is far beyond any video Tuck edits; anything longer is a bad request, not a video
const MAX_DURATION_SECONDS: f64 = 7.0 * 24.0 * 3600.0;

/// Where playback runs: the bare clock, or the native player library decoding and drawing.
enum Backend {
    Clock(Engine),
    Video(Video),
}

impl Backend {
    fn play(&mut self) {
        match self {
            Backend::Clock(engine) => engine.play(),
            Backend::Video(video) => video.play(),
        }
    }

    fn pause(&mut self) {
        match self {
            Backend::Clock(engine) => engine.pause(),
            Backend::Video(video) => video.pause(),
        }
    }

    fn seek(&mut self, request_id: u64, seconds: f64) -> bool {
        match self {
            Backend::Clock(engine) => engine.seek(request_id, seconds),
            Backend::Video(video) => video.seek(request_id, seconds),
        }
    }

    fn volume(&mut self, gain: f64) {
        // the bare clock has no sound
        if let Backend::Video(video) = self {
            video.volume(gain);
        }
    }

    fn status(&mut self) -> PlayerStatus {
        match self {
            Backend::Clock(engine) => {
                // without a renderer, a new position counts as shown as soon as it is asked for
                engine.present_current_frame();
                engine.status()
            }
            Backend::Video(video) => {
                let (mut status, info) = video.status();
                status.video = Some(info);
                status
            }
        }
    }
}

/// The one player for the editor's selected video. Cloning shares it.
#[derive(Clone, Default)]
pub struct PlayerState(Arc<Mutex<Option<Backend>>>);

impl PlayerState {
    fn backend(&self) -> std::sync::MutexGuard<'_, Option<Backend>> {
        // a panic while holding the lock leaves plain data behind, still safe to use
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn check_length(duration_seconds: f64) -> Result<(), PlayerError> {
        if duration_seconds.is_finite()
            && duration_seconds > 0.0
            && duration_seconds <= MAX_DURATION_SECONDS
        {
            Ok(())
        } else {
            Err(PlayerError::InvalidLength)
        }
    }

    /// Starts over for a video of `duration_seconds` on the bare clock, replacing any previous one.
    pub fn open(&self, duration_seconds: f64) -> Result<PlayerStatus, PlayerError> {
        Self::check_length(duration_seconds)?;
        let engine = Engine::open(duration_seconds).ok_or(PlayerError::InvalidLength)?;
        let mut backend = Backend::Clock(engine);
        let status = backend.status();
        *self.backend() = Some(backend);
        Ok(status)
    }

    /// Opens `path` in the native player library, drawing into `window`. Slow, so it runs off the
    /// main thread. The previous video closes first: a window holds one swap chain at a time.
    pub fn open_video(
        &self,
        duration_seconds: f64,
        path: &Path,
        window: *mut c_void,
        display_interval: f64,
        download_frames: bool,
    ) -> Result<PlayerStatus, PlayerError> {
        Self::check_length(duration_seconds)?;
        // closing joins the previous video's threads; status reads must not wait on that
        let previous = self.backend().take();
        drop(previous);
        let video = Video::open(
            path,
            duration_seconds,
            window,
            display_interval,
            download_frames,
        )
        .map_err(PlayerError::Video)?;
        let mut backend = Backend::Video(video);
        let status = backend.status();
        *self.backend() = Some(backend);
        Ok(status)
    }

    pub fn command(&self, command: PlayerCommand) -> Result<PlayerStatus, PlayerError> {
        let mut guard = self.backend();
        let backend = guard.as_mut().ok_or(PlayerError::NotOpen)?;
        match command {
            PlayerCommand::Play => backend.play(),
            PlayerCommand::Pause => backend.pause(),
            PlayerCommand::Seek {
                request_id,
                seconds,
            } => {
                if !backend.seek(request_id, seconds) {
                    return Err(PlayerError::SeekRefused);
                }
            }
            PlayerCommand::Volume { volume } => {
                if !(0.0..=1.0).contains(&volume) {
                    return Err(PlayerError::InvalidVolume);
                }
                backend.volume(volume);
            }
        }
        Ok(backend.status())
    }

    pub fn status(&self) -> Result<PlayerStatus, PlayerError> {
        self.backend()
            .as_mut()
            .map(Backend::status)
            .ok_or(PlayerError::NotOpen)
    }

    /// Whether the GL area should draw again to show a new frame.
    #[cfg(target_os = "linux")]
    pub fn due(&self) -> bool {
        match self.backend().as_mut() {
            Some(Backend::Video(video)) => video.due(),
            _ => false,
        }
    }

    /// Draws the open video into the bound framebuffer, or clears it while there is none.
    #[cfg(target_os = "linux")]
    pub fn draw(&self, renderer: &super::library::GlRenderer, target: &super::library::Target) {
        match self.backend().as_mut() {
            Some(Backend::Video(video)) => {
                video.draw(renderer, target);
            }
            _ => renderer.clear(target),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    extern "C" {
        fn tuck_player_test_failures() -> i32;
    }

    #[test]
    fn the_c_player_core_passes_its_own_tests() {
        // each failed check is printed to stderr with its file and line
        assert_eq!(unsafe { tuck_player_test_failures() }, 0);
    }

    #[test]
    fn an_engine_needs_a_real_duration() {
        assert!(Engine::open(0.0).is_none());
        assert!(Engine::open(-1.0).is_none());
        assert!(Engine::open(f64::NAN).is_none());
        assert!(Engine::open(f64::INFINITY).is_none());
        assert!(Engine::open(12.0).is_some());
    }

    #[test]
    fn a_seek_is_confirmed_once_its_frame_is_shown() {
        let mut engine = Engine::open(12.0).expect("engine");
        engine.present_current_frame();
        assert!(engine.seek(1, 5.0));
        let pending = engine.status();
        assert!(pending.seek_pending);
        assert_eq!(pending.position_seconds, 5.0);
        assert_eq!(pending.confirmed_seek_request_id, 0);
        engine.present_current_frame();
        let shown = engine.status();
        assert!(!shown.seek_pending);
        assert_eq!(shown.confirmed_seek_request_id, 1);
        assert!(!engine.seek(1, 6.0), "a repeated request ID is refused");
        assert!(!engine.seek(2, 13.0), "a position past the end is refused");
    }

    #[test]
    fn commands_parse_strictly() {
        let parse = |json: &str| serde_json::from_str::<PlayerCommand>(json);
        assert_eq!(parse(r#"{"kind":"play"}"#).unwrap(), PlayerCommand::Play);
        assert_eq!(parse(r#"{"kind":"pause"}"#).unwrap(), PlayerCommand::Pause);
        assert_eq!(
            parse(r#"{"kind":"seek","requestId":3,"seconds":1.5}"#).unwrap(),
            PlayerCommand::Seek {
                request_id: 3,
                seconds: 1.5
            }
        );
        assert!(parse(r#"{"kind":"seek","requestId":3}"#).is_err());
        assert!(parse(r#"{"kind":"seek","requestId":-1,"seconds":1}"#).is_err());
        assert!(parse(r#"{"kind":"seek","requestId":3,"seconds":1,"extra":true}"#).is_err());
        assert!(parse(r#"{"kind":"eject"}"#).is_err());
        assert_eq!(
            parse(r#"{"kind":"volume","volume":0.5}"#).unwrap(),
            PlayerCommand::Volume { volume: 0.5 }
        );
        assert!(parse(r#"{"kind":"volume"}"#).is_err());
        assert!(parse(r#"{"kind":"volume","volume":"loud"}"#).is_err());
    }

    #[test]
    fn the_player_state_follows_the_rules() {
        let state = PlayerState::default();
        assert_eq!(state.status(), Err(PlayerError::NotOpen));
        assert_eq!(
            state.command(PlayerCommand::Play),
            Err(PlayerError::NotOpen)
        );
        assert_eq!(state.open(0.0), Err(PlayerError::InvalidLength));
        assert_eq!(state.open(1e9), Err(PlayerError::InvalidLength));
        let opened = state.open(20.0).expect("open");
        assert!(opened.paused && !opened.seek_pending && opened.position_seconds == 0.0);
        let playing = state.command(PlayerCommand::Play).expect("play");
        assert!(!playing.paused);
        let seek = |request_id, seconds| {
            state.command(PlayerCommand::Seek {
                request_id,
                seconds,
            })
        };
        let moved = seek(1, 7.5).expect("seek");
        assert_eq!(moved.confirmed_seek_request_id, 1);
        assert!(!moved.seek_pending);
        assert_eq!(seek(1, 3.0), Err(PlayerError::SeekRefused));
        assert_eq!(seek(2, 21.0), Err(PlayerError::SeekRefused));
        let paused = state.command(PlayerCommand::Pause).expect("pause");
        assert!(paused.paused && paused.position_seconds >= 7.5);
        let volume = |volume| state.command(PlayerCommand::Volume { volume });
        assert!(volume(0.0).is_ok() && volume(1.0).is_ok());
        assert_eq!(volume(1.5), Err(PlayerError::InvalidVolume));
        assert_eq!(volume(-0.1), Err(PlayerError::InvalidVolume));
        assert_eq!(volume(f64::NAN), Err(PlayerError::InvalidVolume));
        // a new video starts over with fresh request IDs
        state.open(5.0).expect("open again");
        assert_eq!(seek(1, 2.0).expect("seek").confirmed_seek_request_id, 1);
    }

    #[test]
    fn the_status_serializes_for_the_page() {
        let mut engine = Engine::open(12.0).expect("engine");
        let value = serde_json::to_value(engine.status()).expect("json");
        for key in [
            "monotonicSeconds",
            "positionSeconds",
            "durationSeconds",
            "generation",
            "seekRequestId",
            "confirmedSeekRequestId",
            "paused",
            "seekPending",
            "ended",
        ] {
            assert!(value.get(key).is_some(), "missing {key}");
        }
    }
}
