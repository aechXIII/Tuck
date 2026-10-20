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
    rate: f64,
}

extern "C" {
    fn tuck_player_create(duration_seconds: f64, now: f64) -> *mut TuckPlayer;
    fn tuck_player_destroy(player: *mut TuckPlayer);
    fn tuck_player_play(player: *mut TuckPlayer, now: f64);
    fn tuck_player_pause(player: *mut TuckPlayer, now: f64);
    fn tuck_player_seek(player: *mut TuckPlayer, request_id: u64, seconds: f64, now: f64) -> i32;
    fn tuck_player_set_rate(player: *mut TuckPlayer, rate: f64, now: f64) -> i32;
    fn tuck_player_set_duration(player: *mut TuckPlayer, duration: f64, now: f64) -> i32;
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
    /// media seconds per second of playing
    pub rate: f64,
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
            rate: raw.rate,
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

    /// False when the rate is outside the editor's playback speeds.
    pub fn set_rate(&mut self, rate: f64) -> bool {
        let now = self.now();
        unsafe { tuck_player_set_rate(self.player.as_ptr(), rate, now) != 0 }
    }

    /// False unless the length is positive and finite.
    pub fn set_duration(&mut self, duration: f64) -> bool {
        let now = self.now();
        unsafe { tuck_player_set_duration(self.player.as_ptr(), duration, now) != 0 }
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
    /// media seconds per second of playing; a new speed restarts at the same spot
    Rate {
        rate: f64,
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
    /// a speed outside the editor's playback speeds
    InvalidRate,
    /// a LUT table or strength the preview can't use
    InvalidLut,
    /// a mix with a piece, voice or file the player can't use
    InvalidMix,
    /// timeline segments out of order, overlapping or outside the timeline
    InvalidEdits,
    /// the native player library could not open the video; the text says why
    Video(String),
}

// the editor's slowest and fastest playback speeds, TUCK_PLAYER_RATE_MIN and _MAX in engine.h
pub const PLAYBACK_RATES: std::ops::RangeInclusive<f64> = 0.25..=4.0;

// what the native player library takes in one mix or one timeline, as video.c checks too
pub const MIX_VOICE_LIMIT: usize = 256;
pub const MIX_PIECE_LIMIT: usize = 65_536;
pub const EDIT_SEGMENT_LIMIT: usize = 65_536;
// the export takes up to +12 dB on a track and +12 dB on a clip, which add up to this
const MIX_GAIN_LIMIT: f64 = 15.9;
// a source has at most this many sound streams (MAX_SOURCE_AUDIO_TRACKS in Python)
const MIX_STREAM_LIMIT: u32 = 64;

/// A stretch of one sound on the timeline, as Python compiles it (tuck/audio_mix.py).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MixPiece {
    pub start: f64,
    pub end: f64,
    pub source_in: f64,
    pub gain: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    pub loop_start: f64,
    pub loop_span: f64,
}

impl MixPiece {
    fn is_valid(&self) -> bool {
        let numbers = [
            self.start,
            self.end,
            self.source_in,
            self.gain,
            self.fade_in,
            self.fade_out,
            self.loop_start,
            self.loop_span,
        ];
        numbers.iter().all(|value| value.is_finite())
            && self.start >= 0.0
            && self.end > self.start
            && self.source_in >= 0.0
            && (0.0..=MIX_GAIN_LIMIT).contains(&self.gain)
            && self.fade_in >= 0.0
            && self.fade_out >= 0.0
            && self.loop_start >= 0.0
            && self.loop_span >= 0.0
    }
}

/// One sound of the mix: a file and which of its sound streams, with where it plays.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MixVoice {
    pub path: String,
    pub stream: u32,
    pub pieces: Vec<MixPiece>,
}

/// The preview mix the page asked Python for, checked here before the library plays it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mix {
    pub duration: f64,
    pub voices: Vec<MixVoice>,
}

impl Mix {
    /// The numbers and sizes the library takes; the files are checked where the command arrives.
    pub fn is_valid(&self) -> bool {
        let pieces: usize = self.voices.iter().map(|voice| voice.pieces.len()).sum();
        self.duration.is_finite()
            && self.duration > 0.0
            && self.voices.len() <= MIX_VOICE_LIMIT
            && pieces <= MIX_PIECE_LIMIT
            && self.voices.iter().all(|voice| {
                voice.stream < MIX_STREAM_LIMIT && voice.pieces.iter().all(MixPiece::is_valid)
            })
    }
}

/// A stretch of the timeline showing the file's footage from `source_start`.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditSegment {
    pub start: f64,
    pub end: f64,
    pub source_start: f64,
}

/// The timeline's length and footage; no segments shows the file as it is.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edits {
    pub duration: f64,
    pub segments: Vec<EditSegment>,
}

impl Edits {
    /// Segments in order, apart from each other and inside the timeline, as edits.h takes them.
    pub fn is_valid(&self) -> bool {
        if !(self.duration.is_finite()
            && self.duration > 0.0
            && self.duration <= MAX_DURATION_SECONDS)
            || self.segments.len() > EDIT_SEGMENT_LIMIT
        {
            return false;
        }
        let mut previous_end = 0.0;
        self.segments.iter().all(|segment| {
            let valid = segment.start.is_finite()
                && segment.end.is_finite()
                && segment.source_start.is_finite()
                && segment.source_start >= 0.0
                && segment.start >= previous_end
                && segment.end > segment.start
                && segment.end <= self.duration + 1e-6;
            previous_end = segment.end;
            valid
        })
    }
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

    fn rate(&mut self, rate: f64) -> bool {
        match self {
            Backend::Clock(engine) => engine.set_rate(rate),
            Backend::Video(video) => video.rate(rate),
        }
    }

    fn edits(&mut self, edits: &Edits) -> bool {
        match self {
            // the bare clock has no picture, so only the timeline's length matters to it
            Backend::Clock(engine) => engine.set_duration(edits.duration),
            Backend::Video(video) => video.edits(edits),
        }
    }

    fn mix(&mut self, mix: &Mix) -> bool {
        match self {
            // the bare clock has no sound
            Backend::Clock(_) => true,
            Backend::Video(video) => video.mix(mix),
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

/// The preview's colour LUT as the page last sent it.
#[derive(Clone)]
struct PreviewLut {
    /// `size`³ RGB samples from 0 to 1, R changing fastest
    table: Option<(Arc<[f32]>, i32)>,
    strength: f64,
}

impl Default for PreviewLut {
    fn default() -> Self {
        PreviewLut {
            table: None,
            strength: 1.0,
        }
    }
}

/// A change to the preview's LUT: a new table (or none), or only a new strength.
#[derive(Clone, Debug, PartialEq)]
pub struct LutUpdate {
    /// `None` keeps the table; `Some(None)` removes it
    pub table: Option<Option<(Vec<f32>, i32)>>,
    pub strength: f64,
}

// the sizes the backend accepts from a .cube file
pub const LUT_SIZES: std::ops::RangeInclusive<i32> = 2..=65;

/// The one player for the editor's selected video. Cloning shares it.
#[derive(Clone, Default)]
pub struct PlayerState {
    backend: Arc<Mutex<Option<Backend>>>,
    /// kept apart from the video, so every newly opened video shows the LUT too
    lut: Arc<Mutex<PreviewLut>>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // a panic while holding the lock leaves plain data behind, still safe to use
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn show_lut(video: &mut Video, lut: &PreviewLut) {
    let table = lut.table.as_ref().map(|(table, size)| (&table[..], *size));
    // the page only sends sizes the library takes, so a refusal can't happen here
    video.lut_table(table);
    video.lut_strength(lut.strength);
}

impl PlayerState {
    fn backend(&self) -> std::sync::MutexGuard<'_, Option<Backend>> {
        locked(&self.backend)
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
        let mut video = Video::open(
            path,
            duration_seconds,
            window,
            display_interval,
            download_frames,
        )
        .map_err(PlayerError::Video)?;
        show_lut(&mut video, &locked(&self.lut));
        let mut backend = Backend::Video(video);
        let status = backend.status();
        *self.backend() = Some(backend);
        Ok(status)
    }

    /// Changes the preview's LUT for the open video and the ones opened after it.
    pub fn set_lut(&self, update: LutUpdate) -> Result<(), PlayerError> {
        if !(0.0..=1.0).contains(&update.strength)
            || update.table.as_ref().is_some_and(|table| {
                table.as_ref().is_some_and(|(data, size)| {
                    !LUT_SIZES.contains(size)
                        || data.len() != (*size as usize).pow(3) * 3
                        || !data.iter().all(|value| (0.0..=1.0).contains(value))
                })
            })
        {
            return Err(PlayerError::InvalidLut);
        }
        let mut lut = locked(&self.lut);
        if let Some(table) = update.table {
            lut.table = table.map(|(data, size)| (Arc::from(data), size));
        }
        lut.strength = update.strength;
        if let Some(Backend::Video(video)) = self.backend().as_mut() {
            show_lut(video, &lut);
        }
        Ok(())
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
            PlayerCommand::Rate { rate } => {
                if !PLAYBACK_RATES.contains(&rate) || !backend.rate(rate) {
                    return Err(PlayerError::InvalidRate);
                }
            }
        }
        Ok(backend.status())
    }

    /// The timeline's length and footage for the open video.
    pub fn set_edits(&self, edits: &Edits) -> Result<PlayerStatus, PlayerError> {
        if !edits.is_valid() {
            return Err(PlayerError::InvalidEdits);
        }
        let mut guard = self.backend();
        let backend = guard.as_mut().ok_or(PlayerError::NotOpen)?;
        if !backend.edits(edits) {
            return Err(PlayerError::InvalidEdits);
        }
        Ok(backend.status())
    }

    /// The preview mix for the open video, played from the next moment on.
    pub fn set_mix(&self, mix: &Mix) -> Result<(), PlayerError> {
        if !mix.is_valid() {
            return Err(PlayerError::InvalidMix);
        }
        let mut guard = self.backend();
        let backend = guard.as_mut().ok_or(PlayerError::NotOpen)?;
        if !backend.mix(mix) {
            return Err(PlayerError::InvalidMix);
        }
        Ok(())
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
        assert_eq!(
            parse(r#"{"kind":"rate","rate":2}"#).unwrap(),
            PlayerCommand::Rate { rate: 2.0 }
        );
        assert!(parse(r#"{"kind":"rate"}"#).is_err());
        assert!(parse(r#"{"kind":"rate","rate":2,"pitch":1}"#).is_err());
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
        let rate = |rate| state.command(PlayerCommand::Rate { rate });
        assert_eq!(opened.rate, 1.0);
        let fast = rate(2.0).expect("rate");
        assert_eq!(fast.rate, 2.0);
        assert!(fast.position_seconds >= 7.5, "a new speed keeps the spot");
        for refused in [0.0, 0.2, 4.5, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(rate(refused), Err(PlayerError::InvalidRate));
        }
        assert_eq!(state.status().expect("status").rate, 2.0);
        // a new video starts over with fresh request IDs
        state.open(5.0).expect("open again");
        assert_eq!(seek(1, 2.0).expect("seek").confirmed_seek_request_id, 1);
    }

    fn piece() -> MixPiece {
        MixPiece {
            start: 2.0,
            end: 6.0,
            source_in: 1.0,
            gain: 0.5,
            fade_in: 0.5,
            fade_out: 1.0,
            loop_start: 0.0,
            loop_span: 0.0,
        }
    }

    fn mix(pieces: Vec<MixPiece>) -> Mix {
        Mix {
            duration: 30.0,
            voices: vec![MixVoice {
                path: "/videos/a.mp4".into(),
                stream: 0,
                pieces,
            }],
        }
    }

    #[test]
    fn a_mix_is_checked_before_the_library_sees_it() {
        assert!(mix(vec![piece()]).is_valid());
        assert!(mix(vec![]).is_valid());
        let gain_boost = MixPiece {
            gain: 15.8,
            ..piece()
        };
        assert!(
            mix(vec![gain_boost]).is_valid(),
            "+24 dB, the editor's highest"
        );
        for broken in [
            MixPiece {
                end: 2.0,
                ..piece()
            },
            MixPiece {
                start: -1.0,
                ..piece()
            },
            MixPiece {
                gain: 16.0,
                ..piece()
            },
            MixPiece {
                gain: f64::NAN,
                ..piece()
            },
            MixPiece {
                fade_out: -0.1,
                ..piece()
            },
            MixPiece {
                loop_span: f64::INFINITY,
                ..piece()
            },
        ] {
            assert!(!mix(vec![broken]).is_valid(), "{broken:?}");
        }
        let mut too_many_streams = mix(vec![piece()]);
        too_many_streams.voices[0].stream = 64;
        assert!(!too_many_streams.is_valid());
        let mut no_length = mix(vec![piece()]);
        no_length.duration = 0.0;
        assert!(!no_length.is_valid());
        let parse = |json: &str| serde_json::from_str::<Mix>(json);
        assert!(parse(r#"{"duration":1,"voices":[]}"#).is_ok());
        assert!(parse(r#"{"duration":1,"voices":[],"limiter":true}"#).is_err());
    }

    #[test]
    fn timeline_segments_go_in_order_inside_the_timeline() {
        let segment = |start, end, source_start| EditSegment {
            start,
            end,
            source_start,
        };
        let edits = |segments| Edits {
            duration: 15.0,
            segments,
        };
        assert!(edits(vec![]).is_valid());
        assert!(edits(vec![segment(0.0, 5.0, 5.0), segment(7.0, 15.0, 12.0)]).is_valid());
        assert!(!edits(vec![segment(0.0, 5.0, 0.0), segment(4.0, 8.0, 0.0)]).is_valid());
        assert!(!edits(vec![segment(3.0, 2.0, 0.0)]).is_valid());
        assert!(!edits(vec![segment(0.0, 16.0, 0.0)]).is_valid());
        assert!(!edits(vec![segment(0.0, 2.0, -1.0)]).is_valid());
        assert!(!Edits {
            duration: f64::NAN,
            segments: vec![]
        }
        .is_valid());
    }

    #[test]
    fn the_bare_clock_takes_the_timelines_length_and_ignores_the_mix() {
        let state = PlayerState::default();
        assert_eq!(
            state.set_mix(&mix(vec![piece()])),
            Err(PlayerError::NotOpen)
        );
        state.open(10.0).expect("open");
        let longer = state
            .set_edits(&Edits {
                duration: 25.0,
                segments: vec![],
            })
            .expect("edits");
        assert_eq!(longer.duration_seconds, 25.0);
        assert_eq!(state.set_mix(&mix(vec![piece()])), Ok(()));
        assert_eq!(
            state.set_mix(&mix(vec![MixPiece {
                end: 0.0,
                ..piece()
            }])),
            Err(PlayerError::InvalidMix)
        );
        assert_eq!(
            state.set_edits(&Edits {
                duration: -1.0,
                segments: vec![]
            }),
            Err(PlayerError::InvalidEdits)
        );
    }

    #[test]
    fn the_preview_lut_is_checked_and_kept_for_later_videos() {
        let state = PlayerState::default();
        let table =
            |size: i32, value: f32| Some(Some((vec![value; (size as usize).pow(3) * 3], size)));
        let update = |table, strength| state.set_lut(LutUpdate { table, strength });
        assert_eq!(update(table(2, 0.5), 0.7), Ok(()));
        assert_eq!(
            update(None, 0.2),
            Ok(()),
            "a strength alone keeps the table"
        );
        assert!(locked(&state.lut).table.is_some());
        assert_eq!(locked(&state.lut).strength, 0.2);
        assert_eq!(update(table(1, 0.5), 1.0), Err(PlayerError::InvalidLut));
        assert_eq!(update(table(66, 0.5), 1.0), Err(PlayerError::InvalidLut));
        assert_eq!(update(table(2, 1.5), 1.0), Err(PlayerError::InvalidLut));
        assert_eq!(
            update(table(2, f32::NAN), 1.0),
            Err(PlayerError::InvalidLut)
        );
        assert_eq!(update(None, 1.1), Err(PlayerError::InvalidLut));
        assert_eq!(
            update(Some(Some((vec![0.5; 5], 2))), 1.0),
            Err(PlayerError::InvalidLut),
            "the table must hold size cubed samples"
        );
        assert!(
            locked(&state.lut).table.is_some(),
            "a refused change leaves the LUT as it was"
        );
        assert_eq!(update(Some(None), 1.0), Ok(()));
        assert!(locked(&state.lut).table.is_none());
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
