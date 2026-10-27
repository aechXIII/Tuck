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

/// The most files one copy or drag takes, which keeps a request from the page small.
pub const MAX_FILES: usize = 100;

/// Checks every path the way `validate_file_path` does and keeps each file once, in the order
/// given. One path that can't be copied fails the whole list.
pub fn validate_file_paths(paths: &[String]) -> Result<Vec<PathBuf>, PublicBackendError> {
    if paths.is_empty() {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            "Choose the files to copy.",
        ));
    }
    if paths.len() > MAX_FILES {
        return Err(PublicBackendError::new(
            "INVALID_REQUEST",
            format!("Copy up to {MAX_FILES} files at a time."),
        ));
    }
    let mut files: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for path in paths {
        // compared after canonicalizing, so two spellings of one file also count once
        let file = validate_file_path(path)?;
        if !files.contains(&file) {
            files.push(file);
        }
    }
    Ok(files)
}

fn clipboard_error() -> PublicBackendError {
    PublicBackendError::new("INTERNAL_ERROR", "Could not copy the file. Try again.")
}

/// The `file://` URI of every path, or `None` when one of them isn't valid UTF-8.
#[cfg(any(test, target_os = "linux"))]
pub(crate) fn file_uris<P: AsRef<Path>>(paths: &[P]) -> Option<Vec<String>> {
    paths
        .iter()
        .map(|path| path.as_ref().to_str().map(file_uri))
        .collect()
}

/// A `text/uri-list`, where every line ends in CRLF.
#[cfg(any(test, target_os = "linux"))]
fn uri_list(uris: &[String]) -> String {
    uris.iter().map(|uri| format!("{uri}\r\n")).collect()
}

/// GNOME's `x-special/gnome-copied-files`: `copy`, then one URI per line.
#[cfg(any(test, target_os = "linux"))]
fn gnome_copied_files(uris: &[String]) -> String {
    std::iter::once("copy")
        .chain(uris.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(any(test, target_os = "linux"))]
pub(crate) fn file_uri(path: &str) -> String {
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

// shell apps that read the file list don't all accept the \\?\ form canonicalize returns
#[cfg(windows)]
fn shell_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
    let drive_prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
    let unc_prefix: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
    if let Some(rest) = encoded.strip_prefix(unc_prefix.as_slice()) {
        [r"\\".encode_utf16().collect::<Vec<_>>(), rest.to_vec()].concat()
    } else {
        encoded
            .strip_prefix(drive_prefix.as_slice())
            .unwrap_or(&encoded)
            .to_vec()
    }
}

#[cfg(windows)]
fn dropfiles_payload<P: AsRef<Path>>(paths: &[P]) -> Vec<u8> {
    // DROPFILES is a 20-byte header, followed by NUL-terminated UTF-16 paths and a final
    // empty path
    let mut payload = vec![0; 20];
    payload[..4].copy_from_slice(&20_u32.to_le_bytes());
    payload[16..20].copy_from_slice(&1_u32.to_le_bytes());
    let units = paths
        .iter()
        .flat_map(|path| shell_path(path.as_ref()).into_iter().chain([0]))
        .chain([0]);
    for unit in units {
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

    pub(super) fn write<P: AsRef<Path>>(
        owner: HWND,
        paths: &[P],
    ) -> Result<(), PublicBackendError> {
        if owner.is_invalid() {
            return Err(clipboard_error());
        }
        let files = GlobalMemory::new(&dropfiles_payload(paths))?;
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

/// Puts `paths` on the clipboard as one entry, the way a file manager copies a selection, so
/// they paste together.
#[cfg(windows)]
pub fn copy_files(window: &tauri::Window, paths: &[PathBuf]) -> Result<(), PublicBackendError> {
    let owner = window.hwnd().map_err(|_| clipboard_error())?;
    windows_clipboard::write(owner, paths)
}

#[cfg(target_os = "linux")]
pub fn copy_files(_window: &tauri::Window, paths: &[PathBuf]) -> Result<(), PublicBackendError> {
    write_linux_files(paths)
}

#[cfg(target_os = "linux")]
fn write_linux_files(paths: &[PathBuf]) -> Result<(), PublicBackendError> {
    let display = gtk::gdk::Display::default().ok_or_else(clipboard_error)?;
    let clipboard = gtk::Clipboard::default(&display).ok_or_else(clipboard_error)?;
    let uris = file_uris(paths).ok_or_else(clipboard_error)?;
    let (uri_text, gnome_text) = (uri_list(&uris), gnome_copied_files(&uris));
    let targets = [
        gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 0),
        gtk::TargetEntry::new("x-special/gnome-copied-files", gtk::TargetFlags::empty(), 1),
    ];
    // GTK retains this callback and its lists until clipboard ownership changes
    if clipboard.set_with_data(&targets, move |_, selection, info| {
        let data = if info == 1 { &gnome_text } else { &uri_text };
        selection.set(&selection.target(), 8, data.as_bytes());
    }) {
        Ok(())
    } else {
        Err(clipboard_error())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn copy_files(_window: &tauri::Window, _paths: &[PathBuf]) -> Result<(), PublicBackendError> {
    Err(PublicBackendError::new(
        "UNSUPPORTED_OPERATION",
        "Copying files is not supported on this platform.",
    ))
}

// a pasted list of paths is short; longer text is something else and isn't searched for paths
const MAX_PATH_TEXT_BYTES: usize = 256 * 1024;

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// The local path in a `file://` URI, or `None` for another scheme or another computer.
fn path_from_file_uri(uri: &str) -> Option<PathBuf> {
    if !uri.get(..7)?.eq_ignore_ascii_case("file://") {
        return None;
    }
    let rest = &uri[7..];
    let slash = rest.find('/')?;
    let host = &rest[..slash];
    if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
        return None;
    }
    let path = percent_decode(&rest[slash..])?;
    if path.contains('\0') {
        return None;
    }
    #[cfg(windows)]
    let path = {
        // file:///C:/Videos/clip.mp4 names C:\Videos\clip.mp4
        let drive = path.as_bytes();
        if drive.len() < 3 || !drive[1].is_ascii_alphabetic() || drive[2] != b':' {
            return None;
        }
        path[1..].replace('/', "\\")
    };
    Some(PathBuf::from(path))
}

/// Paths in a `text/uri-list`, the format Linux file managers copy files as.
pub fn paths_from_uri_list(text: &str) -> Vec<PathBuf> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(path_from_file_uri)
        .collect()
}

/// Paths in GNOME's `x-special/gnome-copied-files`: `copy` or `cut`, then one URI per line.
pub fn paths_from_gnome_copied_files(text: &str) -> Vec<PathBuf> {
    match text.split_once('\n') {
        Some((action, uris)) if matches!(action.trim(), "copy" | "cut") => {
            paths_from_uri_list(uris)
        }
        _ => Vec::new(),
    }
}

/// Absolute paths or file URIs in copied text, one per line, with or without the quotes
/// Explorer's "Copy as path" adds. Text with anything else in it isn't a list of files.
pub fn paths_from_text(text: &str) -> Vec<PathBuf> {
    if text.len() > MAX_PATH_TEXT_BYTES {
        return Vec::new();
    }
    let mut paths = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let line = line
            .strip_prefix('"')
            .and_then(|inner| inner.strip_suffix('"'))
            .unwrap_or(line);
        let path = if line
            .get(..5)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
        {
            path_from_file_uri(line)
        } else {
            Some(PathBuf::from(line)).filter(|path| path.is_absolute() && !line.contains('\0'))
        };
        match path {
            Some(path) => paths.push(path),
            None => return Vec::new(),
        }
    }
    paths
}

/// The paths that name existing files, once each and in order. Folders, missing files and
/// names the page can't hold as text are left out.
pub fn existing_files(paths: Vec<PathBuf>) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for path in paths {
        let Some(text) = path.to_str() else {
            continue;
        };
        if files.iter().any(|file| file == text) {
            continue;
        }
        if std::fs::metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
            files.push(text.to_owned());
        }
    }
    files
}

/// Files copied in Explorer, or `None` when the clipboard holds no file list.
#[cfg(windows)]
pub fn read_copied_files() -> Result<Option<Vec<PathBuf>>, PublicBackendError> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    struct OpenClipboardGuard;
    impl Drop for OpenClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    if unsafe { IsClipboardFormatAvailable(CF_HDROP.0 as u32) }.is_err() {
        return Ok(None);
    }
    unsafe { OpenClipboard(None) }.map_err(|_| {
        PublicBackendError::new(
            "CLIPBOARD_UNAVAILABLE",
            "The clipboard is busy. Try pasting again.",
        )
    })?;
    let _guard = OpenClipboardGuard;
    let Ok(handle) = (unsafe { GetClipboardData(CF_HDROP.0 as u32) }) else {
        return Ok(None);
    };
    // the clipboard owns the file list, which stays valid until the clipboard closes
    let files = HDROP(handle.0);
    let count = unsafe { DragQueryFileW(files, u32::MAX, None) };
    let mut paths = Vec::new();
    for index in 0..count {
        let length = unsafe { DragQueryFileW(files, index, None) } as usize;
        if length == 0 {
            continue;
        }
        let mut name = vec![0_u16; length + 1];
        let copied = unsafe { DragQueryFileW(files, index, Some(&mut name)) } as usize;
        paths.push(PathBuf::from(std::ffi::OsString::from_wide(
            &name[..copied.min(length)],
        )));
    }
    Ok(Some(paths))
}

/// Calls `done` with the files copied in a Linux file manager, or with paths copied as text.
/// GTK answers on the main thread once the app that owns the clipboard has replied.
#[cfg(target_os = "linux")]
pub fn read_copied_files(done: impl FnOnce(Vec<PathBuf>) + 'static) {
    type Parse = fn(&str) -> Vec<PathBuf>;
    // file managers offer one of these; the first is the standard one
    const FILE_LISTS: [(&str, Parse); 2] = [
        ("text/uri-list", paths_from_uri_list),
        (
            "x-special/gnome-copied-files",
            paths_from_gnome_copied_files,
        ),
    ];
    let Some(clipboard) =
        gtk::gdk::Display::default().and_then(|display| gtk::Clipboard::default(&display))
    else {
        return done(Vec::new());
    };
    let formats = gtk::gdk::Atom::intern("TARGETS");
    clipboard.request_contents(&formats, move |clipboard, offered| {
        let targets = offered.targets().unwrap_or_default();
        let list = FILE_LISTS
            .into_iter()
            .find(|(name, _)| targets.iter().any(|target| target.name() == *name));
        match list {
            Some((name, parse)) => {
                clipboard.request_contents(&gtk::gdk::Atom::intern(name), move |_, selection| {
                    done(parse(&String::from_utf8_lossy(&selection.data())))
                });
            }
            None => clipboard
                .request_text(move |_, text| done(text.map(paths_from_text).unwrap_or_default())),
        }
    });
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

    fn text_of(path: &Path) -> String {
        path.to_str().unwrap().to_owned()
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
    fn file_clipboard_lists_keep_each_file_once_in_order() {
        let directory = TestDirectory::new();
        let first = directory.0.join("Zażółć #100% [final].mp4");
        let second = directory.0.join("second.mov");
        std::fs::write(&first, b"export bytes").unwrap();
        std::fs::write(&second, b"export bytes").unwrap();
        let files = validate_file_paths(&[
            text_of(&second),
            text_of(&first),
            text_of(&second),
            text_of(&directory.0.join(".").join("second.mov")),
        ])
        .unwrap();
        assert_eq!(
            files,
            vec![
                validate_file_path(&text_of(&second)).unwrap(),
                validate_file_path(&text_of(&first)).unwrap()
            ]
        );
        assert_eq!(std::fs::read(first).unwrap(), b"export bytes");
    }

    #[test]
    fn file_clipboard_lists_need_one_to_a_hundred_files_that_can_all_be_copied() {
        let directory = TestDirectory::new();
        let file = directory.0.join("export.mp4");
        std::fs::write(&file, b"export bytes").unwrap();
        let path = file.to_str().unwrap().to_owned();

        let empty = validate_file_paths(&[]).unwrap_err();
        assert_eq!(
            (empty.code.as_str(), empty.message.as_str()),
            ("INVALID_REQUEST", "Choose the files to copy.")
        );
        assert_eq!(
            validate_file_paths(&vec![path.clone(); MAX_FILES])
                .unwrap()
                .len(),
            1
        );
        let too_many = validate_file_paths(&vec![path.clone(); MAX_FILES + 1]).unwrap_err();
        assert_eq!(
            (too_many.code.as_str(), too_many.message.as_str()),
            ("INVALID_REQUEST", "Copy up to 100 files at a time.")
        );
        // one path that can't be copied fails the whole list, wherever it is
        for bad in [
            String::new(),
            "video.mp4".to_owned(),
            text_of(&directory.0),
            text_of(&directory.0.join("missing.mp4")),
        ] {
            for paths in [[path.clone(), bad.clone()], [bad.clone(), path.clone()]] {
                assert_eq!(
                    validate_file_paths(&paths).unwrap_err().code,
                    "INVALID_REQUEST",
                    "{paths:?}"
                );
            }
        }
    }

    #[test]
    fn file_clipboard_uri_escapes_unicode_delimiters_and_newlines() {
        assert_eq!(
            file_uri("/tmp/Zażółć #100%?\n.mp4"),
            "file:///tmp/Za%C5%BC%C3%B3%C5%82%C4%87%20%23100%25%3F%0A.mp4"
        );
    }

    #[test]
    fn file_clipboard_linux_lists_name_every_file_on_its_own_line() {
        let uris = file_uris(&["/tmp/Zażółć #100%.mp4", "/tmp/second clip.mkv"]).unwrap();
        let first = "file:///tmp/Za%C5%BC%C3%B3%C5%82%C4%87%20%23100%25.mp4";
        let second = "file:///tmp/second%20clip.mkv";
        assert_eq!(uris, [first, second]);
        assert_eq!(uri_list(&uris), format!("{first}\r\n{second}\r\n"));
        assert_eq!(
            gnome_copied_files(&uris),
            format!("copy\n{first}\n{second}")
        );
        // one file gets the same lists a single copy has always offered
        assert_eq!(uri_list(&uris[..1]), format!("{first}\r\n"));
        assert_eq!(gnome_copied_files(&uris[..1]), format!("copy\n{first}"));
        // Tuck's own paste reads back every copied file
        #[cfg(not(windows))]
        {
            let paths = vec![
                PathBuf::from("/tmp/Zażółć #100%.mp4"),
                PathBuf::from("/tmp/second clip.mkv"),
            ];
            assert_eq!(paths_from_uri_list(&uri_list(&uris)), paths);
            assert_eq!(
                paths_from_gnome_copied_files(&gnome_copied_files(&uris)),
                paths
            );
        }
    }

    // a local file URI and the path it names on this platform
    #[cfg(not(windows))]
    const LOCAL: (&str, &str) = (
        "file:///home/me/Za%C5%BC%C3%B3%C5%82%C4%87%20%23100%25.mp4",
        "/home/me/Zażółć #100%.mp4",
    );
    #[cfg(windows)]
    const LOCAL: (&str, &str) = (
        "file:///C:/Users/me/Za%C5%BC%C3%B3%C5%82%C4%87%20%23100%25.mp4",
        r"C:\Users\me\Zażółć #100%.mp4",
    );

    #[test]
    fn pasted_uri_lists_keep_local_files_and_skip_comments_and_other_places() {
        let list = format!(
            "# copied by a file manager\r\n{}\r\nhttps://example.com/video.mp4\r\nfile://server/share/video.mp4\r\n\r\n{}\r\n",
            LOCAL.0,
            LOCAL.0.replacen("file://", "FILE://localhost", 1),
        );
        assert_eq!(
            paths_from_uri_list(&list),
            vec![PathBuf::from(LOCAL.1), PathBuf::from(LOCAL.1)]
        );
        // broken escapes and text that isn't UTF-8 can't name a file the page could add
        assert!(paths_from_uri_list(
            "file:///tmp/bad%zz.mp4\nfile:///tmp/%FF.mp4\nfile:///tmp/%00.mp4\nfile:///tmp/cut%2"
        )
        .is_empty());
    }

    #[test]
    fn pasted_gnome_file_lists_need_their_copy_or_cut_line() {
        assert_eq!(
            paths_from_gnome_copied_files(&format!("copy\n{}", LOCAL.0)),
            vec![PathBuf::from(LOCAL.1)]
        );
        assert_eq!(
            paths_from_gnome_copied_files(&format!("cut\n{}\n", LOCAL.0)),
            vec![PathBuf::from(LOCAL.1)]
        );
        assert!(paths_from_gnome_copied_files(LOCAL.0).is_empty());
        assert!(paths_from_gnome_copied_files("").is_empty());
    }

    #[test]
    fn pasted_text_counts_only_when_every_line_is_an_absolute_path() {
        #[cfg(not(windows))]
        let (first, second) = ("/home/me/one.mp4", "/home/me/two words.mkv");
        #[cfg(windows)]
        let (first, second) = (r"C:\Videos\one.mp4", r"D:\Videos\two words.mkv");
        // Explorer's "Copy as path" quotes every path
        assert_eq!(
            paths_from_text(&format!("\"{first}\"\r\n  {second}  \r\n\r\n{}", LOCAL.0)),
            vec![
                PathBuf::from(first),
                PathBuf::from(second),
                PathBuf::from(LOCAL.1)
            ]
        );
        for text in [
            "",
            "video.mp4",
            "Remember to export the video",
            &format!("{first}\nand some notes"),
            "https://example.com/video.mp4",
        ] {
            assert!(paths_from_text(text).is_empty(), "{text:?}");
        }
        let long = format!("{first}\n").repeat(MAX_PATH_TEXT_BYTES / first.len() + 1);
        assert!(paths_from_text(&long).is_empty());
    }

    #[test]
    fn only_existing_files_are_pasted_once_each_in_order() {
        let directory = TestDirectory::new();
        let first = directory.0.join("Zażółć #100%.mp4");
        let second = directory.0.join("second.mov");
        std::fs::write(&first, b"video").unwrap();
        std::fs::write(&second, b"video").unwrap();
        let files = existing_files(vec![
            second.clone(),
            directory.0.clone(),
            directory.0.join("missing.mp4"),
            first.clone(),
            second.clone(),
        ]);
        assert_eq!(
            files,
            vec![
                second.to_str().unwrap().to_owned(),
                first.to_str().unwrap().to_owned()
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an isolated graphical display, such as xvfb-run"]
    fn file_clipboard_linux_paste_reads_a_copied_file_and_falls_back_to_text() {
        gtk::init().unwrap();
        let read = || {
            let result = std::rc::Rc::new(std::cell::RefCell::new(None));
            let slot = result.clone();
            read_copied_files(move |paths| *slot.borrow_mut() = Some(paths));
            let context = gtk::glib::MainContext::default();
            while result.borrow().is_none() {
                context.iteration(true);
            }
            result.take().unwrap()
        };
        let directory = TestDirectory::new();
        let file = directory.0.join("Zażółć #100%?\n.mp4");
        let second = directory.0.join("second.mp4");
        std::fs::write(&file, b"export bytes").unwrap();
        std::fs::write(&second, b"export bytes").unwrap();
        write_linux_files(std::slice::from_ref(&file)).unwrap();
        assert_eq!(read(), vec![file.clone()]);
        write_linux_files(&[second.clone(), file.clone()]).unwrap();
        assert_eq!(read(), vec![second, file.clone()]);

        let display = gtk::gdk::Display::default().unwrap();
        let clipboard = gtk::Clipboard::default(&display).unwrap();
        clipboard.set_text("not a path");
        assert!(read().is_empty());
        let plain = directory.0.join("plain.mp4");
        clipboard.set_text(plain.to_str().unwrap());
        assert_eq!(read(), vec![plain]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an isolated graphical display, such as xvfb-run"]
    fn file_clipboard_linux_round_trip_retains_copy_targets_until_replaced() {
        gtk::init().unwrap();
        let directory = TestDirectory::new();
        for filenames in [
            &["Zażółć #100%?\n.mp4"][..],
            &["replacement.mp4"],
            &["first of two.mp4", "second of two.mkv"],
        ] {
            let mut paths = Vec::new();
            for filename in filenames {
                let file = directory.0.join(filename);
                std::fs::write(&file, b"export bytes").unwrap();
                paths.push(file.to_str().unwrap().to_owned());
            }
            let paths = validate_file_paths(&paths).unwrap();
            write_linux_files(&paths).unwrap();
            // reacquiring the clipboard after write returns exercises the retained callback
            let display = gtk::gdk::Display::default().unwrap();
            let clipboard = gtk::Clipboard::default(&display).unwrap();
            let uris: Vec<String> = paths
                .iter()
                .map(|path| file_uri(path.to_str().unwrap()))
                .collect();
            for (target, expected) in [
                (
                    "text/uri-list",
                    uris.iter()
                        .map(|uri| format!("{uri}\r\n"))
                        .collect::<String>(),
                ),
                (
                    "x-special/gnome-copied-files",
                    format!("copy\n{}", uris.join("\n")),
                ),
            ] {
                let selection = clipboard
                    .wait_for_contents(&gtk::gdk::Atom::intern(target))
                    .unwrap();
                assert_eq!(selection.data(), expected.as_bytes());
            }
            for path in paths {
                assert_eq!(std::fs::read(path).unwrap(), b"export bytes");
            }
        }
    }

    // the paths in a DROPFILES payload, after checking its header and its double NUL ending
    #[cfg(windows)]
    fn dropfiles_entries(payload: &[u8]) -> Vec<String> {
        assert_eq!(u32::from_le_bytes(payload[0..4].try_into().unwrap()), 20);
        assert_eq!(u32::from_le_bytes(payload[16..20].try_into().unwrap()), 1);
        let encoded: Vec<u16> = payload[20..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .collect();
        assert_eq!(&encoded[encoded.len() - 2..], &[0, 0]);
        encoded[..encoded.len() - 2]
            .split(|unit| *unit == 0)
            .map(|entry| {
                assert!(!entry.is_empty(), "an empty entry would end the list early");
                String::from_utf16(entry).unwrap()
            })
            .collect()
    }

    #[cfg(windows)]
    #[test]
    fn file_clipboard_dropfiles_has_unicode_paths_and_double_nul_termination() {
        let path = r"C:\Videos\Zażółć #100% [final].mp4";
        assert_eq!(dropfiles_entries(&dropfiles_payload(&[path])), [path]);
        let paths = [
            path,
            r"D:\Exports\日本語 clip, take 2.mkv",
            r"\\server\share\Überschrift.mov",
        ];
        assert_eq!(dropfiles_entries(&dropfiles_payload(&paths)), paths);
    }

    #[cfg(windows)]
    #[test]
    fn file_clipboard_dropfiles_converts_extended_drive_and_unc_paths_for_shell_apps() {
        let cases = [
            (r"\\?\C:\Videos\video.mp4", r"C:\Videos\video.mp4"),
            (
                r"\\?\UNC\server\Videos\video.mp4",
                r"\\server\Videos\video.mp4",
            ),
            (r"\\?\D:\Exports\Zażółć.mkv", r"D:\Exports\Zażółć.mkv"),
            (r"E:\Plain\clip.mp4", r"E:\Plain\clip.mp4"),
        ];
        for (input, expected) in cases {
            assert_eq!(dropfiles_entries(&dropfiles_payload(&[input])), [expected]);
        }
        // every entry of a longer list is converted on its own
        assert_eq!(
            dropfiles_entries(&dropfiles_payload(&cases.map(|(input, _)| input))),
            cases.map(|(_, expected)| expected)
        );
    }

    #[cfg(windows)]
    #[test]
    fn file_clipboard_rejects_an_invalid_owner_without_changing_the_clipboard() {
        for paths in [&[r"C:\video.mp4"][..], &[r"C:\one.mp4", r"C:\two.mp4"]] {
            assert_eq!(
                windows_clipboard::write(windows::Win32::Foundation::HWND::default(), paths)
                    .unwrap_err()
                    .code,
                "INTERNAL_ERROR"
            );
        }
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
        let files = [
            directory.0.join("Zażółć #100% [final].mp4"),
            directory.0.join("second take.mkv"),
        ];
        for file in &files {
            std::fs::write(file, b"export bytes").unwrap();
        }
        let paths = validate_file_paths(&files.each_ref().map(|file| text_of(file))).unwrap();
        windows_clipboard::write(window.0, &paths).unwrap();

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
            let list = unsafe { GetClipboardData(CF_HDROP.0 as u32) }.unwrap();
            let drop = HDROP(list.0);
            assert_eq!(
                unsafe { DragQueryFileW(drop, u32::MAX, None) } as usize,
                files.len()
            );
            for (index, file) in files.iter().enumerate() {
                let index = index as u32;
                let length = unsafe { DragQueryFileW(drop, index, None) } as usize;
                let mut name = vec![0; length + 1];
                assert_eq!(
                    unsafe { DragQueryFileW(drop, index, Some(&mut name)) } as usize,
                    length
                );
                assert_eq!(
                    String::from_utf16(&name[..length]).unwrap(),
                    file.to_str().unwrap()
                );
            }
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
        for file in files {
            assert_eq!(std::fs::read(file).unwrap(), b"export bytes");
        }
    }
}
