//! The native player library, loaded at run time from next to the executable (or from
//! `TUCK_PLAYER_LIBRARY` in development). A missing library, or one built for another interface
//! version, makes opening fail with a reason instead of stopping the app from starting.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::OnceLock;

use serde::Serialize;

use super::engine::{Edits, Mix, PlayerStatus, RawStatus};

// must match TUCK_VIDEO_ABI in native/player/tuck_video.h
const ABI: c_int = 8;

#[cfg(windows)]
const FILE_NAME: &str = "tuck_player.dll";
#[cfg(not(windows))]
const FILE_NAME: &str = "libtuck_player.so";

#[repr(C)]
struct OpenParams {
    path: *const c_char,
    duration_seconds: f64,
    window: *mut c_void,
    display_interval: f64,
    download_frames: i32,
}

/// Where the Linux GL area draws: its size and the picture inside it, in device pixels from the
/// top left.
#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Target {
    pub width: i32,
    pub height: i32,
    pub picture_x: i32,
    pub picture_y: i32,
    pub picture_width: i32,
    pub picture_height: i32,
}

#[repr(C)]
struct RawVideoStatus {
    clock: RawStatus,
    frame_rate: f64,
    presented: u64,
    hardware: i32,
    failed: i32,
    decoder: [c_char; 48],
    error: [c_char; 192],
    sound_underruns: u64,
    sound: i32,
    sound_error: [c_char; 160],
    software_reason: i32,
}

type OpenFn = unsafe extern "C" fn(*const OpenParams, *mut c_char, usize) -> *mut c_void;
type VideoFn = unsafe extern "C" fn(*mut c_void);
type SeekFn = unsafe extern "C" fn(*mut c_void, u64, f64) -> c_int;
type VolumeFn = unsafe extern "C" fn(*mut c_void, f64);
type RateFn = unsafe extern "C" fn(*mut c_void, f64) -> c_int;
type MixFn =
    unsafe extern "C" fn(*mut c_void, *const RawMixVoice, i32, *const RawMixPiece, i32) -> c_int;
type EditsFn = unsafe extern "C" fn(*mut c_void, *const RawEditSegment, i32, f64) -> c_int;

// TuckMixVoice, TuckMixPiece and TuckEditSegment in tuck_video.h
#[repr(C)]
struct RawMixVoice {
    path: *const c_char,
    stream: i32,
}

#[repr(C)]
struct RawMixPiece {
    voice: i32,
    start: f64,
    end: f64,
    source_in: f64,
    gain: f64,
    fade_in: f64,
    fade_out: f64,
    loop_start: f64,
    loop_span: f64,
}

#[repr(C)]
struct RawEditSegment {
    start: f64,
    end: f64,
    source_start: f64,
}
type LutTableFn = unsafe extern "C" fn(*mut c_void, *const f32, i32) -> c_int;
type StatusFn = unsafe extern "C" fn(*mut c_void, *mut RawVideoStatus);
#[cfg(target_os = "linux")]
type RendererCreateFn = unsafe extern "C" fn(*mut c_char, usize) -> *mut c_void;
#[cfg(target_os = "linux")]
type RendererTargetFn = unsafe extern "C" fn(*mut c_void, *const Target);
#[cfg(target_os = "linux")]
type DueFn = unsafe extern "C" fn(*mut c_void, f64) -> c_int;
#[cfg(target_os = "linux")]
type ImportsFn = unsafe extern "C" fn(*mut c_void) -> c_int;
#[cfg(target_os = "linux")]
type DrawFn = unsafe extern "C" fn(*mut c_void, *mut c_void, *const Target, f64) -> c_int;

struct Api {
    open: OpenFn,
    close: VideoFn,
    play: VideoFn,
    pause: VideoFn,
    seek: SeekFn,
    volume: VolumeFn,
    rate: RateFn,
    mix: MixFn,
    edits: EditsFn,
    lut_table: LutTableFn,
    lut_strength: VolumeFn,
    status: StatusFn,
    #[cfg(target_os = "linux")]
    gl: GlApi,
}

// GTK draws on its main thread, so on Linux the shell drives the drawing
#[cfg(target_os = "linux")]
struct GlApi {
    create: RendererCreateFn,
    destroy: VideoFn,
    imports: ImportsFn,
    clear: RendererTargetFn,
    due: DueFn,
    draw: DrawFn,
}

/// What the page learns about the decoder and renderer beside the clock.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub decoder: String,
    pub hardware: bool,
    /// why the frames come from software decoding; `None` while the GPU decodes them
    pub software_reason: Option<SoftwareReason>,
    pub frame_rate: f64,
    pub presented: u64,
    pub failed: bool,
    pub error: String,
    pub sound: SoundInfo,
}

/// The video's sound: whether it plays, and why not when it can't.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundInfo {
    pub state: SoundState,
    /// times the device wanted sound before it was decoded
    pub underruns: u64,
    pub error: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SoundState {
    /// the file has no sound
    None,
    /// the sound plays and the clock follows what the listener has heard
    Playing,
    /// the file has sound that can't play; the clock runs on its own
    Unavailable,
}

impl SoundState {
    // TUCK_SOUND_* in native/player/tuck_video.h
    fn from_raw(raw: i32) -> Self {
        match raw {
            1 => SoundState::Playing,
            2 => SoundState::Unavailable,
            _ => SoundState::None,
        }
    }
}

/// Why the native player decodes in software instead of on the GPU.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SoftwareReason {
    /// no GPU decoding device could be opened, such as a missing or refusing driver
    NoDevice,
    /// the GPU decoders don't handle this codec
    Codec,
    /// the GPU decoder for this codec could not start
    StartFailed,
    /// the GPU can't decode this particular stream, such as its profile or pixel format
    Stream,
}

impl SoftwareReason {
    // TUCK_SOFTWARE_* in native/player/tuck_video.h; anything else means hardware decoding
    fn from_raw(raw: i32) -> Option<Self> {
        match raw {
            1 => Some(SoftwareReason::NoDevice),
            2 => Some(SoftwareReason::Codec),
            3 => Some(SoftwareReason::StartFailed),
            4 => Some(SoftwareReason::Stream),
            _ => None,
        }
    }
}

pub struct Video {
    handle: NonNull<c_void>,
    api: &'static Api,
}

// the library guards each video with its own lock and lets any thread call it
unsafe impl Send for Video {}

fn text(raw: &[c_char]) -> String {
    let bytes: Vec<u8> = raw
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn library_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("TUCK_PLAYER_LIBRARY") {
        return Some(PathBuf::from(path));
    }
    Some(std::env::current_exe().ok()?.parent()?.join(FILE_NAME))
}

#[cfg(windows)]
fn load(path: &Path) -> Result<Api, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCSTR, PCWSTR};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    // the library stays loaded for the life of the app, like the shell's other native parts
    let module = unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())) }
        .map_err(|_| "The native player library is missing.".to_string())?;
    let symbol = |name: &CStr| unsafe { GetProcAddress(module, PCSTR(name.as_ptr().cast())) };
    resolve(|name| symbol(name).map(|f| f as *const c_void))
}

#[cfg(not(windows))]
fn load(path: &Path) -> Result<Api, String> {
    use std::os::unix::ffi::OsStrExt;
    let name = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "The native player library path is not valid.".to_string())?;
    let module = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    if module.is_null() {
        return Err("The native player library is missing.".to_string());
    }
    resolve(|name| {
        let symbol = unsafe { libc::dlsym(module, name.as_ptr()) };
        (!symbol.is_null()).then_some(symbol as *const c_void)
    })
}

fn resolve(symbol: impl Fn(&CStr) -> Option<*const c_void>) -> Result<Api, String> {
    let find = |name: &CStr| {
        symbol(name).ok_or_else(|| "The native player library is incomplete.".to_string())
    };
    unsafe {
        let abi: unsafe extern "C" fn() -> c_int = std::mem::transmute(find(c"tuck_video_abi")?);
        if abi() != ABI {
            return Err("The native player library is from another Tuck version.".to_string());
        }
        Ok(Api {
            open: std::mem::transmute::<*const c_void, OpenFn>(find(c"tuck_video_open")?),
            close: std::mem::transmute::<*const c_void, VideoFn>(find(c"tuck_video_close")?),
            play: std::mem::transmute::<*const c_void, VideoFn>(find(c"tuck_video_play")?),
            pause: std::mem::transmute::<*const c_void, VideoFn>(find(c"tuck_video_pause")?),
            seek: std::mem::transmute::<*const c_void, SeekFn>(find(c"tuck_video_seek")?),
            volume: std::mem::transmute::<*const c_void, VolumeFn>(find(c"tuck_video_volume")?),
            rate: std::mem::transmute::<*const c_void, RateFn>(find(c"tuck_video_rate")?),
            mix: std::mem::transmute::<*const c_void, MixFn>(find(c"tuck_video_mix")?),
            edits: std::mem::transmute::<*const c_void, EditsFn>(find(c"tuck_video_edits")?),
            lut_table: std::mem::transmute::<*const c_void, LutTableFn>(find(
                c"tuck_video_lut_table",
            )?),
            lut_strength: std::mem::transmute::<*const c_void, VolumeFn>(find(
                c"tuck_video_lut_strength",
            )?),
            status: std::mem::transmute::<*const c_void, StatusFn>(find(c"tuck_video_status")?),
            #[cfg(target_os = "linux")]
            gl: GlApi {
                create: std::mem::transmute::<*const c_void, RendererCreateFn>(find(
                    c"tuck_gl_renderer_create",
                )?),
                destroy: std::mem::transmute::<*const c_void, VideoFn>(find(
                    c"tuck_gl_renderer_destroy",
                )?),
                imports: std::mem::transmute::<*const c_void, ImportsFn>(find(
                    c"tuck_gl_renderer_imports_frames",
                )?),
                clear: std::mem::transmute::<*const c_void, RendererTargetFn>(find(
                    c"tuck_gl_renderer_clear",
                )?),
                due: std::mem::transmute::<*const c_void, DueFn>(find(c"tuck_video_due")?),
                draw: std::mem::transmute::<*const c_void, DrawFn>(find(c"tuck_video_draw")?),
            },
        })
    }
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| {
        let path = library_path().ok_or("The native player library is missing.")?;
        load(&path)
    })
    .as_ref()
    .map_err(Clone::clone)
}

impl Video {
    /// Opens `path` for playback into `window` (the preview's child window on Windows; unused on
    /// Linux). `display_interval` is the seconds between display refreshes, or 0 when unknown.
    /// `download_frames` copies decoded GPU frames to memory for a renderer that can't import them.
    pub fn open(
        path: &Path,
        duration_seconds: f64,
        window: *mut c_void,
        display_interval: f64,
        download_frames: bool,
    ) -> Result<Self, String> {
        let api = api()?;
        let path = path
            .to_str()
            .and_then(|path| CString::new(path).ok())
            .ok_or("The video's file name can't be opened.")?;
        let params = OpenParams {
            path: path.as_ptr(),
            duration_seconds,
            window,
            display_interval,
            download_frames: i32::from(download_frames),
        };
        let mut error = [0 as c_char; 256];
        let handle = unsafe { (api.open)(&params, error.as_mut_ptr(), error.len()) };
        NonNull::new(handle)
            .map(|handle| Video { handle, api })
            .ok_or_else(|| text(&error))
    }

    pub fn play(&mut self) {
        unsafe { (self.api.play)(self.handle.as_ptr()) }
    }

    pub fn pause(&mut self) {
        unsafe { (self.api.pause)(self.handle.as_ptr()) }
    }

    pub fn seek(&mut self, request_id: u64, seconds: f64) -> bool {
        unsafe { (self.api.seek)(self.handle.as_ptr(), request_id, seconds) != 0 }
    }

    /// The sound's level, 0 to 1.
    pub fn volume(&mut self, gain: f64) {
        unsafe { (self.api.volume)(self.handle.as_ptr(), gain) }
    }

    /// Media seconds per second of playing. False when the library refuses the speed.
    pub fn rate(&mut self, rate: f64) -> bool {
        unsafe { (self.api.rate)(self.handle.as_ptr(), rate) != 0 }
    }

    /// Plays `mix` from the next moment on. False when the library refuses it; a path with a NUL
    /// in it is refused here.
    pub fn mix(&mut self, mix: &Mix) -> bool {
        let Ok(paths) = mix
            .voices
            .iter()
            .map(|voice| CString::new(voice.path.as_str()))
            .collect::<Result<Vec<_>, _>>()
        else {
            return false;
        };
        let voices: Vec<RawMixVoice> = mix
            .voices
            .iter()
            .zip(&paths)
            .map(|(voice, path)| RawMixVoice {
                path: path.as_ptr(),
                stream: voice.stream as i32,
            })
            .collect();
        let pieces: Vec<RawMixPiece> = mix
            .voices
            .iter()
            .enumerate()
            .flat_map(|(index, voice)| {
                voice.pieces.iter().map(move |piece| RawMixPiece {
                    voice: index as i32,
                    start: piece.start,
                    end: piece.end,
                    source_in: piece.source_in,
                    gain: piece.gain,
                    fade_in: piece.fade_in,
                    fade_out: piece.fade_out,
                    loop_start: piece.loop_start,
                    loop_span: piece.loop_span,
                })
            })
            .collect();
        // the library copies everything before returning, so the strings may go afterwards
        unsafe {
            (self.api.mix)(
                self.handle.as_ptr(),
                voices.as_ptr(),
                voices.len() as i32,
                pieces.as_ptr(),
                pieces.len() as i32,
            ) != 0
        }
    }

    /// The timeline's length and footage. False when the library refuses them.
    pub fn edits(&mut self, edits: &Edits) -> bool {
        let segments: Vec<RawEditSegment> = edits
            .segments
            .iter()
            .map(|segment| RawEditSegment {
                start: segment.start,
                end: segment.end,
                source_start: segment.source_start,
            })
            .collect();
        unsafe {
            (self.api.edits)(
                self.handle.as_ptr(),
                segments.as_ptr(),
                segments.len() as i32,
                edits.duration,
            ) != 0
        }
    }

    /// The preview's colour LUT: `size`³ RGB samples, R changing fastest; `None` removes it.
    /// False when the library refuses the size.
    pub fn lut_table(&mut self, table: Option<(&[f32], i32)>) -> bool {
        let (data, size) =
            table.map_or((std::ptr::null(), 0), |(data, size)| (data.as_ptr(), size));
        unsafe { (self.api.lut_table)(self.handle.as_ptr(), data, size) != 0 }
    }

    /// How much of the LUT shows, 0 to 1.
    pub fn lut_strength(&mut self, strength: f64) {
        unsafe { (self.api.lut_strength)(self.handle.as_ptr(), strength) }
    }

    pub fn status(&mut self) -> (PlayerStatus, VideoInfo) {
        let mut raw = RawVideoStatus {
            clock: RawStatus::default(),
            frame_rate: 0.0,
            presented: 0,
            hardware: 0,
            failed: 0,
            decoder: [0; 48],
            error: [0; 192],
            sound_underruns: 0,
            sound: 0,
            sound_error: [0; 160],
            software_reason: 0,
        };
        unsafe { (self.api.status)(self.handle.as_ptr(), &mut raw) };
        let info = VideoInfo {
            decoder: text(&raw.decoder),
            hardware: raw.hardware != 0,
            software_reason: SoftwareReason::from_raw(raw.software_reason),
            frame_rate: raw.frame_rate,
            presented: raw.presented,
            failed: raw.failed != 0,
            error: text(&raw.error),
            sound: SoundInfo {
                state: SoundState::from_raw(raw.sound),
                underruns: raw.sound_underruns,
                error: text(&raw.sound_error),
            },
        };
        (raw.clock.into(), info)
    }
}

impl Drop for Video {
    fn drop(&mut self) {
        unsafe { (self.api.close)(self.handle.as_ptr()) }
    }
}

#[cfg(target_os = "linux")]
impl Video {
    /// Whether drawing would show a different frame than the last draw. `shown_at` is when the
    /// frame reaches the screen, in monotonic seconds; 0 means now.
    pub fn due(&mut self, shown_at: f64) -> bool {
        unsafe { (self.api.gl.due)(self.handle.as_ptr(), shown_at) != 0 }
    }

    /// Draws the frame for the clock at `shown_at` into the bound framebuffer. Only from the GL
    /// area's render handler, with its context current.
    pub fn draw(&mut self, renderer: &GlRenderer, target: &Target, shown_at: f64) -> bool {
        unsafe {
            (self.api.gl.draw)(
                self.handle.as_ptr(),
                renderer.handle.as_ptr(),
                target,
                shown_at,
            ) != 0
        }
    }
}

/// libplacebo's OpenGL renderer for the Linux GL area. It lives as long as the area's GL context,
/// across videos, and is created and dropped only with that context current.
#[cfg(target_os = "linux")]
pub struct GlRenderer {
    handle: NonNull<c_void>,
    api: &'static Api,
}

#[cfg(target_os = "linux")]
impl GlRenderer {
    pub fn create() -> Result<Self, String> {
        let api = api()?;
        let mut error = [0 as c_char; 256];
        let handle = unsafe { (api.gl.create)(error.as_mut_ptr(), error.len()) };
        NonNull::new(handle)
            .map(|handle| GlRenderer { handle, api })
            .ok_or_else(|| text(&error))
    }

    /// Whether the GL context takes VAAPI frames without a copy; GLX under X11 can't.
    pub fn imports_frames(&self) -> bool {
        unsafe { (self.api.gl.imports)(self.handle.as_ptr()) != 0 }
    }

    /// Clears the bound framebuffer while no video plays.
    pub fn clear(&self, target: &Target) {
        unsafe { (self.api.gl.clear)(self.handle.as_ptr(), target) }
    }
}

#[cfg(target_os = "linux")]
impl Drop for GlRenderer {
    fn drop(&mut self) {
        unsafe { (self.api.gl.destroy)(self.handle.as_ptr()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe extern "C" fn current_abi() -> c_int {
        ABI
    }

    unsafe extern "C" fn other_abi() -> c_int {
        ABI + 1
    }

    // a library that exports only its version function
    fn only_abi(abi: unsafe extern "C" fn() -> c_int) -> impl Fn(&CStr) -> Option<*const c_void> {
        move |name| (name == c"tuck_video_abi").then_some(abi as *const c_void)
    }

    #[test]
    fn a_library_from_another_version_is_refused() {
        let error = resolve(only_abi(other_abi)).err().expect("refused");
        assert!(error.contains("another Tuck version"), "{error}");
    }

    #[test]
    fn a_library_missing_a_function_is_refused() {
        let error = resolve(only_abi(current_abi)).err().expect("refused");
        assert!(error.contains("incomplete"), "{error}");
        assert!(resolve(|_| None).is_err());
    }

    #[test]
    fn the_status_struct_matches_the_c_layout() {
        // TuckVideoStatus in tuck_video.h, laid out by the C compiler for 64-bit targets
        assert_eq!(std::mem::offset_of!(RawVideoStatus, frame_rate), 72);
        assert_eq!(std::mem::offset_of!(RawVideoStatus, sound_underruns), 336);
        assert_eq!(std::mem::offset_of!(RawVideoStatus, sound), 344);
        assert_eq!(std::mem::offset_of!(RawVideoStatus, sound_error), 348);
        assert_eq!(std::mem::offset_of!(RawVideoStatus, software_reason), 508);
        assert_eq!(std::mem::size_of::<RawVideoStatus>(), 512);
    }

    #[test]
    fn the_mix_and_timeline_structs_match_the_c_layout() {
        // TuckMixVoice, TuckMixPiece and TuckEditSegment in tuck_video.h, for 64-bit targets
        assert_eq!(std::mem::size_of::<RawMixVoice>(), 16);
        assert_eq!(std::mem::offset_of!(RawMixPiece, start), 8);
        assert_eq!(std::mem::offset_of!(RawMixPiece, loop_span), 64);
        assert_eq!(std::mem::size_of::<RawMixPiece>(), 72);
        assert_eq!(std::mem::size_of::<RawEditSegment>(), 24);
    }

    #[test]
    fn sound_states_come_from_the_library_codes() {
        assert_eq!(SoundState::from_raw(0), SoundState::None);
        assert_eq!(SoundState::from_raw(1), SoundState::Playing);
        assert_eq!(SoundState::from_raw(2), SoundState::Unavailable);
        assert_eq!(SoundState::from_raw(7), SoundState::None);
    }

    #[test]
    fn software_reasons_come_from_the_library_codes() {
        assert_eq!(SoftwareReason::from_raw(0), None);
        assert_eq!(SoftwareReason::from_raw(1), Some(SoftwareReason::NoDevice));
        assert_eq!(SoftwareReason::from_raw(2), Some(SoftwareReason::Codec));
        assert_eq!(
            SoftwareReason::from_raw(3),
            Some(SoftwareReason::StartFailed)
        );
        assert_eq!(SoftwareReason::from_raw(4), Some(SoftwareReason::Stream));
        assert_eq!(SoftwareReason::from_raw(9), None);
    }

    #[test]
    fn software_reasons_reach_the_page_as_short_codes() {
        let codes: Vec<String> = [
            SoftwareReason::NoDevice,
            SoftwareReason::Codec,
            SoftwareReason::StartFailed,
            SoftwareReason::Stream,
        ]
        .iter()
        .map(|reason| serde_json::to_string(reason).expect("serializes"))
        .collect();
        assert_eq!(
            codes,
            [
                r#""no-device""#,
                r#""codec""#,
                r#""start-failed""#,
                r#""stream""#
            ]
        );
    }

    #[test]
    fn text_from_the_library_stops_at_its_end() {
        let raw = [b'o' as c_char, b'k' as c_char, 0, b'x' as c_char];
        assert_eq!(text(&raw), "ok");
        assert_eq!(text(&[0; 4]), "");
    }
}
