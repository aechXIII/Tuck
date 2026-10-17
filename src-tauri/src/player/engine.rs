//! Safe owner of the C player core. The C object is not thread-safe, so every call goes through
//! one `Engine` behind the player state's mutex.

use std::ptr::NonNull;
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};

#[repr(C)]
struct TuckPlayer {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Default)]
struct TuckPlayerStatus {
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
    fn tuck_player_status(player: *mut TuckPlayer, now: f64, status: *mut TuckPlayerStatus);
}

/// What the page sees of the player. Request IDs stay below 2^53, so they are exact in JavaScript.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
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
        let mut raw = TuckPlayerStatus::default();
        unsafe { tuck_player_status(self.player.as_ptr(), now, &mut raw) };
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
        }
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlayerError {
    NotOpen,
    InvalidLength,
    /// an old or repeated request ID, or a position outside the video
    SeekRefused,
}

// a week is far beyond any video Tuck edits; anything longer is a bad request, not a video
const MAX_DURATION_SECONDS: f64 = 7.0 * 24.0 * 3600.0;

/// The one engine for the editor's selected video.
#[derive(Default)]
pub struct PlayerState(Mutex<Option<Engine>>);

impl PlayerState {
    fn engine(&self) -> std::sync::MutexGuard<'_, Option<Engine>> {
        // a panic while holding the lock leaves plain data behind, still safe to use
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts over for a video of `duration_seconds`, replacing any previous one.
    pub fn open(&self, duration_seconds: f64) -> Result<PlayerStatus, PlayerError> {
        // the C core refuses NaN, infinite and non-positive lengths itself
        if duration_seconds > MAX_DURATION_SECONDS {
            return Err(PlayerError::InvalidLength);
        }
        let mut engine = Engine::open(duration_seconds).ok_or(PlayerError::InvalidLength)?;
        engine.present_current_frame();
        let status = engine.status();
        *self.engine() = Some(engine);
        Ok(status)
    }

    pub fn command(&self, command: PlayerCommand) -> Result<PlayerStatus, PlayerError> {
        let mut guard = self.engine();
        let engine = guard.as_mut().ok_or(PlayerError::NotOpen)?;
        match command {
            PlayerCommand::Play => engine.play(),
            PlayerCommand::Pause => engine.pause(),
            PlayerCommand::Seek {
                request_id,
                seconds,
            } => {
                if !engine.seek(request_id, seconds) {
                    return Err(PlayerError::SeekRefused);
                }
            }
        }
        engine.present_current_frame();
        Ok(engine.status())
    }

    pub fn status(&self) -> Result<PlayerStatus, PlayerError> {
        self.engine()
            .as_mut()
            .map(Engine::status)
            .ok_or(PlayerError::NotOpen)
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
