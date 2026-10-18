//! The native player library, loaded at run time from next to the executable (or from
//! `TUCK_PLAYER_LIBRARY` in development). A missing library, or one built for another interface
//! version, makes opening fail with a reason instead of stopping the app from starting.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::OnceLock;

use serde::Serialize;

use super::engine::{PlayerStatus, RawStatus};

// must match TUCK_VIDEO_ABI in native/player/tuck_video.h
const ABI: c_int = 1;

#[cfg(windows)]
const FILE_NAME: &str = "tuck_player.dll";
#[cfg(not(windows))]
const FILE_NAME: &str = "libtuck_player.so";

#[repr(C)]
struct OpenParams {
    path: *const c_char,
    duration_seconds: f64,
    window: *mut c_void,
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
}

type OpenFn = unsafe extern "C" fn(*const OpenParams, *mut c_char, usize) -> *mut c_void;
type VideoFn = unsafe extern "C" fn(*mut c_void);
type SeekFn = unsafe extern "C" fn(*mut c_void, u64, f64) -> c_int;
type StatusFn = unsafe extern "C" fn(*mut c_void, *mut RawVideoStatus);

struct Api {
    open: OpenFn,
    close: VideoFn,
    play: VideoFn,
    pause: VideoFn,
    seek: SeekFn,
    status: StatusFn,
}

/// What the page learns about the decoder and renderer beside the clock.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub decoder: String,
    pub hardware: bool,
    pub frame_rate: f64,
    pub presented: u64,
    pub failed: bool,
    pub error: String,
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
            status: std::mem::transmute::<*const c_void, StatusFn>(find(c"tuck_video_status")?),
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
    /// Opens `path` for playback into `window` (the preview's child window on Windows).
    pub fn open(path: &Path, duration_seconds: f64, window: *mut c_void) -> Result<Self, String> {
        let api = api()?;
        let path = path
            .to_str()
            .and_then(|path| CString::new(path).ok())
            .ok_or("The video's file name can't be opened.")?;
        let params = OpenParams {
            path: path.as_ptr(),
            duration_seconds,
            window,
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

    pub fn status(&mut self) -> (PlayerStatus, VideoInfo) {
        let mut raw = RawVideoStatus {
            clock: RawStatus::default(),
            frame_rate: 0.0,
            presented: 0,
            hardware: 0,
            failed: 0,
            decoder: [0; 48],
            error: [0; 192],
        };
        unsafe { (self.api.status)(self.handle.as_ptr(), &mut raw) };
        let info = VideoInfo {
            decoder: text(&raw.decoder),
            hardware: raw.hardware != 0,
            frame_rate: raw.frame_rate,
            presented: raw.presented,
            failed: raw.failed != 0,
            error: text(&raw.error),
        };
        (raw.clock.into(), info)
    }
}

impl Drop for Video {
    fn drop(&mut self) {
        unsafe { (self.api.close)(self.handle.as_ptr()) }
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
    fn text_from_the_library_stops_at_its_end() {
        let raw = [b'o' as c_char, b'k' as c_char, 0, b'x' as c_char];
        assert_eq!(text(&raw), "ok");
        assert_eq!(text(&[0; 4]), "");
    }
}
