use std::path::{Path, PathBuf};

use crate::backend::protocol::PublicBackendError;

pub fn validate_file_path(path: &str) -> Result<PathBuf, PublicBackendError> {
    if path.trim().is_empty() || path.contains('\0') || !Path::new(path).is_absolute() {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Choose an existing file to copy.",
        ));
    }
    let path = std::fs::canonicalize(path).map_err(|_| {
        PublicBackendError::new(
            "INVALID_REQUEST",
            "Could not access this file. Check that it still exists and try again.",
        )
    })?;
    if !path.is_file() {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Choose a file to copy, rather than a folder.",
        ));
    }
    Ok(path)
}

fn clipboard_error() -> PublicBackendError {
    PublicBackendError::new("INTERNAL_ERROR", "Could not copy the file. Try again.")
}

#[cfg(any(test, target_os = "linux"))]
fn file_uri(path: &str) -> String {
    use std::fmt::Write;
    let mut uri = String::from("file://");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            write!(uri, "%{byte:02X}").expect("writing into a string cannot fail");
        }
    }
    uri
}

#[cfg(windows)]
fn dropfiles_payload(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    let encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
    let drive_prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
    let unc_prefix: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
    let shell_path = if let Some(rest) = encoded.strip_prefix(unc_prefix.as_slice()) {
        [r"\\".encode_utf16().collect::<Vec<_>>(), rest.to_vec()].concat()
    } else {
        encoded
            .strip_prefix(drive_prefix.as_slice())
            .unwrap_or(&encoded)
            .to_vec()
    };
    // DROPFILES is a 20-byte header, followed by UTF-16 paths and a final empty path
    let mut payload = vec![0; 20];
    payload[..4].copy_from_slice(&20_u32.to_le_bytes());
    payload[16..20].copy_from_slice(&1_u32.to_le_bytes());
    for unit in shell_path.into_iter().chain([0, 0]) {
        payload.extend_from_slice(&unit.to_le_bytes());
    }
    payload
}

#[cfg(windows)]
mod windows_clipboard {
    use super::*;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;

    struct GlobalMemory(HGLOBAL);

    impl GlobalMemory {
        fn new(payload: &[u8]) -> Result<Self, PublicBackendError> {
            // movable memory stays owned here until SetClipboardData accepts it
            let allocation = Self(
                unsafe { GlobalAlloc(GMEM_MOVEABLE, payload.len()) }
                    .map_err(|_| clipboard_error())?,
            );
            let pointer = unsafe { GlobalLock(allocation.0) };
            if pointer.is_null() {
                return Err(clipboard_error());
            }
            // the locked allocation has exactly payload.len() writable bytes
            unsafe {
                std::ptr::copy_nonoverlapping(payload.as_ptr(), pointer.cast(), payload.len());
                let _ = GlobalUnlock(allocation.0);
            }
            Ok(allocation)
        }

        fn publish(mut self, format: u32) -> Result<(), PublicBackendError> {
            // Windows owns the allocation only after this call succeeds
            unsafe { SetClipboardData(format, Some(HANDLE(self.0 .0))) }
                .map_err(|_| clipboard_error())?;
            self.0 = HGLOBAL::default();
            Ok(())
        }
    }

    impl Drop for GlobalMemory {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = GlobalFree(Some(self.0));
                }
            }
        }
    }

    struct OpenClipboardGuard;

    impl Drop for OpenClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    pub(super) fn write(owner: HWND, path: &Path) -> Result<(), PublicBackendError> {
        if owner.is_invalid() {
            return Err(clipboard_error());
        }
        let files = GlobalMemory::new(&dropfiles_payload(path))?;
        let effect = GlobalMemory::new(&1_u32.to_le_bytes())?;
        let effect_format =
            unsafe { RegisterClipboardFormatW(windows::core::w!("Preferred DropEffect")) };
        if effect_format == 0 {
            return Err(clipboard_error());
        }
        unsafe { OpenClipboard(Some(owner)) }.map_err(|_| {
            PublicBackendError::new(
                "CLIPBOARD_UNAVAILABLE",
                "The clipboard is busy. Try copying the file again.",
            )
        })?;
        let _guard = OpenClipboardGuard;
        unsafe { EmptyClipboard() }.map_err(|_| clipboard_error())?;
        effect.publish(effect_format)?;
        files.publish(CF_HDROP.0 as u32)
    }
}

#[cfg(windows)]
pub fn copy_file(window: &tauri::Window, path: &Path) -> Result<(), PublicBackendError> {
    let owner = window.hwnd().map_err(|_| clipboard_error())?;
    windows_clipboard::write(owner, path)
}

#[cfg(target_os = "linux")]
pub fn copy_file(_window: &tauri::Window, path: &Path) -> Result<(), PublicBackendError> {
    write_linux_file(path)
}

#[cfg(target_os = "linux")]
fn write_linux_file(path: &Path) -> Result<(), PublicBackendError> {
    let display = gtk::gdk::Display::default().ok_or_else(clipboard_error)?;
    let clipboard = gtk::Clipboard::default(&display).ok_or_else(clipboard_error)?;
    let path = path.to_str().ok_or_else(clipboard_error)?;
    let uri = file_uri(path);
    let targets = [
        gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 0),
        gtk::TargetEntry::new("x-special/gnome-copied-files", gtk::TargetFlags::empty(), 1),
    ];
    // GTK retains this callback and its URI until clipboard ownership changes
    if clipboard.set_with_data(&targets, move |_, selection, info| {
        let data = if info == 1 {
            format!("copy\n{uri}")
        } else {
            format!("{uri}\r\n")
        };
        selection.set(&selection.target(), 8, data.as_bytes());
    }) {
        Ok(())
    } else {
        Err(clipboard_error())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn copy_file(_window: &tauri::Window, _path: &Path) -> Result<(), PublicBackendError> {
    Err(PublicBackendError::new(
        "UNSUPPORTED_OPERATION",
        "Copying files is not supported on this platform.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "tuck-file-clipboard-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn file_clipboard_accepts_an_existing_unicode_file_without_reading_or_changing_it() {
        let directory = TestDirectory::new();
        let file = directory.0.join("Zażółć #100% [final].mp4");
        std::fs::write(&file, b"export bytes").unwrap();
        let validated = validate_file_path(file.to_str().unwrap()).unwrap();
        assert!(validated.is_absolute());
        assert_eq!(std::fs::read(validated).unwrap(), b"export bytes");
        assert_eq!(std::fs::read(file).unwrap(), b"export bytes");
    }

    #[test]
    fn file_clipboard_rejects_empty_nul_relative_missing_and_directory_paths() {
        let directory = TestDirectory::new();
        for path in [
            "",
            " ",
            "video.mp4",
            "bad\0file.mp4",
            directory.0.to_str().unwrap(),
            directory.0.join("missing.mp4").to_str().unwrap(),
        ] {
            assert_eq!(
                validate_file_path(path).unwrap_err().code,
                "INVALID_REQUEST"
            );
        }
    }

    #[test]
    fn file_clipboard_uri_escapes_unicode_delimiters_and_newlines() {
        assert_eq!(
            file_uri("/tmp/Zażółć #100%?\n.mp4"),
            "file:///tmp/Za%C5%BC%C3%B3%C5%82%C4%87%20%23100%25%3F%0A.mp4"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an isolated graphical display, such as xvfb-run"]
    fn file_clipboard_linux_round_trip_retains_copy_targets_until_replaced() {
        gtk::init().unwrap();
        let directory = TestDirectory::new();
        for filename in ["Zażółć #100%?\n.mp4", "replacement.mp4"] {
            let file = directory.0.join(filename);
            std::fs::write(&file, b"export bytes").unwrap();
            let path = validate_file_path(file.to_str().unwrap()).unwrap();
            write_linux_file(&path).unwrap();
            // reacquiring the clipboard after write returns exercises the retained callback
            let display = gtk::gdk::Display::default().unwrap();
            let clipboard = gtk::Clipboard::default(&display).unwrap();
            let uri = file_uri(path.to_str().unwrap());
            for (target, expected) in [
                ("text/uri-list", format!("{uri}\r\n")),
                ("x-special/gnome-copied-files", format!("copy\n{uri}")),
            ] {
                let selection = clipboard
                    .wait_for_contents(&gtk::gdk::Atom::intern(target))
                    .unwrap();
                assert_eq!(selection.data(), expected.as_bytes());
            }
            assert_eq!(std::fs::read(file).unwrap(), b"export bytes");
        }
    }

    #[cfg(windows)]
    #[test]
    fn file_clipboard_dropfiles_has_unicode_paths_and_double_nul_termination() {
        let path = std::path::Path::new(r"C:\Videos\Zażółć #100% [final].mp4");
        let payload = dropfiles_payload(path);
        assert_eq!(u32::from_le_bytes(payload[0..4].try_into().unwrap()), 20);
        assert_eq!(u32::from_le_bytes(payload[16..20].try_into().unwrap()), 1);
        let encoded: Vec<u16> = payload[20..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .collect();
        assert_eq!(&encoded[encoded.len() - 2..], &[0, 0]);
        assert_eq!(
            String::from_utf16(&encoded[..encoded.len() - 2]).unwrap(),
            path.to_str().unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn file_clipboard_dropfiles_converts_extended_drive_and_unc_paths_for_shell_apps() {
        for (input, expected) in [
            (r"\\?\C:\Videos\video.mp4", r"C:\Videos\video.mp4"),
            (
                r"\\?\UNC\server\Videos\video.mp4",
                r"\\server\Videos\video.mp4",
            ),
        ] {
            let payload = dropfiles_payload(std::path::Path::new(input));
            let encoded: Vec<u16> = payload[20..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
                .collect();
            assert_eq!(
                String::from_utf16(&encoded[..encoded.len() - 2]).unwrap(),
                expected
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn file_clipboard_rejects_an_invalid_owner_without_changing_the_clipboard() {
        assert_eq!(
            windows_clipboard::write(
                windows::Win32::Foundation::HWND::default(),
                Path::new(r"C:\video.mp4")
            )
            .unwrap_err()
            .code,
            "INTERNAL_ERROR"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires an empty interactive Windows clipboard"]
    fn file_clipboard_windows_round_trip() {
        use windows::Win32::Foundation::HGLOBAL;
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, OpenClipboard,
            RegisterClipboardFormatW,
        };
        use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
        use windows::Win32::System::Ole::CF_HDROP;
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
        };

        struct ClipboardTestWindow(windows::Win32::Foundation::HWND);
        impl Drop for ClipboardTestWindow {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }

        struct EmptyClipboardOnDrop(windows::Win32::Foundation::HWND);
        impl Drop for EmptyClipboardOnDrop {
            fn drop(&mut self) {
                unsafe {
                    if OpenClipboard(Some(self.0)).is_ok() {
                        let _ = EmptyClipboard();
                        let _ = CloseClipboard();
                    }
                }
            }
        }

        let window = ClipboardTestWindow(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                windows::core::w!("STATIC"),
                windows::core::w!("Tuck clipboard test"),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
            .unwrap()
        });
        unsafe {
            OpenClipboard(Some(window.0)).unwrap();
        }
        let previous_format = unsafe { EnumClipboardFormats(0) };
        unsafe {
            CloseClipboard().unwrap();
        }
        assert_eq!(previous_format, 0, "the clipboard must be empty before this opt-in test; existing clipboard data was left unchanged");
        let _cleanup = EmptyClipboardOnDrop(window.0);
        let directory = TestDirectory::new();
        let file = directory.0.join("Zażółć #100% [final].mp4");
        std::fs::write(&file, b"export bytes").unwrap();
        let path = validate_file_path(file.to_str().unwrap()).unwrap();
        windows_clipboard::write(window.0, &path).unwrap();

        unsafe {
            OpenClipboard(Some(window.0)).unwrap();
        }
        struct CloseClipboardOnDrop;
        impl Drop for CloseClipboardOnDrop {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseClipboard();
                }
            }
        }
        {
            let _close = CloseClipboardOnDrop;
            let files = unsafe { GetClipboardData(CF_HDROP.0 as u32) }.unwrap();
            let drop = HDROP(files.0);
            assert_eq!(unsafe { DragQueryFileW(drop, u32::MAX, None) }, 1);
            let length = unsafe { DragQueryFileW(drop, 0, None) } as usize;
            let mut name = vec![0; length + 1];
            assert_eq!(
                unsafe { DragQueryFileW(drop, 0, Some(&mut name)) } as usize,
                length
            );
            assert_eq!(
                String::from_utf16(&name[..length]).unwrap(),
                file.to_str().unwrap()
            );
            let format =
                unsafe { RegisterClipboardFormatW(windows::core::w!("Preferred DropEffect")) };
            let effect_handle = unsafe { GetClipboardData(format) }.unwrap();
            let pointer = unsafe { GlobalLock(HGLOBAL(effect_handle.0)) };
            assert!(!pointer.is_null());
            let effect = unsafe { std::ptr::read_unaligned(pointer.cast::<u32>()) };
            unsafe {
                let _ = GlobalUnlock(HGLOBAL(effect_handle.0));
            }
            assert_eq!(effect, 1);
        }
        assert_eq!(std::fs::read(file).unwrap(), b"export bytes");
    }
}
