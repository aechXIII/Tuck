//! Moving videos to the Trash (the Recycle Bin on Windows) and renaming them. Both act on files
//! the page names, so each path must be an existing video file, and a file is never deleted for
//! good: one that can't go to the Trash stays where it is.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::backend::protocol::PublicBackendError;

/// The most videos one request moves, which keeps a request from the page small.
pub const MAX_TRASH: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrashOutcome {
    Moved,
    /// the drive has no Trash (a USB stick formatted for Windows, a network folder), so the file stayed
    NoTrash,
    /// the file was already gone
    Missing,
    /// something else kept it, such as another program holding it open
    Failed,
}

#[derive(Debug, Serialize)]
pub struct TrashResult {
    pub path: String,
    pub outcome: TrashOutcome,
}

fn has_video_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extensions.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn invalid(message: &str) -> PublicBackendError {
    PublicBackendError::new("INVALID_REQUEST", message)
}

/// An absolute path to a video file; a missing one is reported per file rather than failing all.
fn checked_video(path: &str, extensions: &[&str]) -> Result<PathBuf, PublicBackendError> {
    let candidate = Path::new(path);
    if path.trim().is_empty() || path.contains('\0') || !candidate.is_absolute() {
        return Err(invalid("Choose videos in the Library."));
    }
    if !has_video_extension(candidate, extensions) {
        return Err(invalid("Only videos can be moved or renamed here."));
    }
    if candidate.is_dir() {
        return Err(invalid("Choose a video, rather than a folder."));
    }
    Ok(candidate.to_path_buf())
}

pub fn trash_videos(
    paths: &[String],
    extensions: &[&str],
) -> Result<Vec<TrashResult>, PublicBackendError> {
    if paths.is_empty() || paths.len() > MAX_TRASH {
        return Err(invalid("Choose up to 500 videos to move to the Trash."));
    }
    let checked = paths
        .iter()
        .map(|path| checked_video(path, extensions))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(paths
        .iter()
        .zip(checked)
        .map(|(path, file)| TrashResult {
            path: path.clone(),
            outcome: if file.is_file() {
                trash_one(&file)
            } else {
                TrashOutcome::Missing
            },
        })
        .collect())
}

#[cfg(target_os = "linux")]
fn trash_one(path: &Path) -> TrashOutcome {
    use gtk::gio;
    use gtk::gio::prelude::FileExt;
    // GIO follows the desktop's Trash rules: the home Trash for the home drive, a .Trash-<uid>
    // folder on other drives, and an error where neither can be made
    match gio::File::for_path(path).trash(gio::Cancellable::NONE) {
        Ok(()) => TrashOutcome::Moved,
        Err(error) if error.matches(gio::IOErrorEnum::NotFound) => TrashOutcome::Missing,
        Err(error) if error.matches(gio::IOErrorEnum::NotSupported) => TrashOutcome::NoTrash,
        Err(_) => TrashOutcome::Failed,
    }
}

#[cfg(target_os = "windows")]
fn trash_one(path: &Path) -> TrashOutcome {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, SHQueryRecycleBinW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI,
        FOF_SILENT, FOF_WANTNUKEWARNING, FO_DELETE, SHFILEOPSTRUCTW, SHQUERYRBINFO,
    };

    // a drive without a Recycle Bin (network folders, some removable drives) would delete the
    // file for good, so it is left alone
    let Some(root) = path.ancestors().last() else {
        return TrashOutcome::Failed;
    };
    let root: Vec<u16> = root.as_os_str().encode_wide().chain([0]).collect();
    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    if unsafe { SHQueryRecycleBinW(PCWSTR(root.as_ptr()), &mut info) }.is_err() {
        return TrashOutcome::NoTrash;
    }
    // the list ends with two nulls
    let from: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect();
    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        // FOF_WANTNUKEWARNING asks the user before Windows would delete instead of recycling,
        // such as a file larger than the Recycle Bin; saying no keeps the file
        fFlags: (FOF_ALLOWUNDO
            | FOF_NOCONFIRMATION
            | FOF_NOERRORUI
            | FOF_SILENT
            | FOF_WANTNUKEWARNING)
            .0 as u16,
        ..Default::default()
    };
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return TrashOutcome::Failed;
    }
    if operation.fAnyOperationsAborted.as_bool() || path.exists() {
        return TrashOutcome::NoTrash;
    }
    TrashOutcome::Moved
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn trash_one(_path: &Path) -> TrashOutcome {
    TrashOutcome::NoTrash
}

// names Windows refuses, so a file renamed on Linux still opens there
const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn checked_name(name: &str, extensions: &[&str]) -> Result<String, PublicBackendError> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err(PublicBackendError::new(
            "NAME_INVALID",
            "Type a name for the video.",
        ));
    }
    if name.chars().any(|c| {
        matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
    }) {
        return Err(PublicBackendError::new(
            "NAME_INVALID",
            "A name can't use / \\ : * ? \" < > or |.",
        ));
    }
    if name.ends_with('.') || name.len() > 240 {
        return Err(PublicBackendError::new(
            "NAME_INVALID",
            "Use a shorter name that doesn't end with a dot.",
        ));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(PublicBackendError::new(
            "NAME_INVALID",
            "Windows keeps that name for itself.",
        ));
    }
    if !has_video_extension(Path::new(name), extensions) {
        return Err(PublicBackendError::new(
            "NAME_INVALID",
            "Keep a video extension at the end, like .mp4.",
        ));
    }
    Ok(name.to_string())
}

/// Renames a video in its own folder and returns its new path. A name another file already has
/// renames nothing.
pub fn rename_video(
    path: &str,
    name: &str,
    extensions: &[&str],
) -> Result<String, PublicBackendError> {
    let file = checked_video(path, extensions)?;
    if !file.is_file() {
        return Err(invalid(
            "The video isn't there any more. It may have been moved or deleted.",
        ));
    }
    let name = checked_name(name, extensions)?;
    let Some(folder) = file.parent() else {
        return Err(invalid("Choose videos in the Library."));
    };
    let target = folder.join(&name);
    if target == file {
        return Ok(file.display().to_string());
    }
    // a change of case only is the same file on Windows and on most Linux drives used with it
    let same_file =
        target.to_string_lossy().to_lowercase() == file.to_string_lossy().to_lowercase();
    if target.exists() && !same_file {
        return Err(taken(&name));
    }
    rename_no_replace(&file, &target, same_file).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            taken(&name)
        } else {
            PublicBackendError::new(
                "RENAME_FAILED",
                "Couldn't rename the video. Another program may have it open.",
            )
        }
    })?;
    Ok(target.display().to_string())
}

fn taken(name: &str) -> PublicBackendError {
    PublicBackendError::new(
        "NAME_TAKEN",
        format!("There's already a file called {name} in that folder."),
    )
}

#[cfg(target_os = "linux")]
fn rename_no_replace(from: &Path, to: &Path, same_file: bool) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    if same_file {
        return std::fs::rename(from, to);
    }
    let from_c = CString::new(from.as_os_str().as_bytes())?;
    let to_c = CString::new(to.as_os_str().as_bytes())?;
    // never replaces a file that appeared since the check above
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from_c.as_ptr(),
            libc::AT_FDCWD,
            to_c.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    // some drives (FAT, network) can't promise that; there the check above stands
    if matches!(
        error.raw_os_error(),
        Some(libc::EINVAL) | Some(libc::ENOSYS)
    ) {
        if to.exists() {
            return Err(std::io::ErrorKind::AlreadyExists.into());
        }
        return std::fs::rename(from, to);
    }
    Err(error)
}

#[cfg(not(target_os = "linux"))]
fn rename_no_replace(from: &Path, to: &Path, same_file: bool) -> std::io::Result<()> {
    if !same_file && to.exists() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    std::fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIDEOS: &[&str] = &["mp4", "mkv"];

    fn folder(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("tuck-file-ops-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn rename_keeps_the_folder_and_never_replaces_a_file() {
        let dir = folder("rename");
        let video = dir.join("Replay.mp4");
        std::fs::write(&video, b"video").unwrap();
        std::fs::write(dir.join("Taken.mp4"), b"other").unwrap();

        let error = rename_video(video.to_str().unwrap(), "Taken.mp4", VIDEOS).unwrap_err();
        assert_eq!(error.code, "NAME_TAKEN");
        assert_eq!(std::fs::read(dir.join("Taken.mp4")).unwrap(), b"other");

        let renamed = rename_video(video.to_str().unwrap(), " Clutch round.mp4 ", VIDEOS).unwrap();
        assert_eq!(PathBuf::from(&renamed), dir.join("Clutch round.mp4"));
        assert!(!video.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_refuses_names_that_leave_the_folder_or_the_videos() {
        let dir = folder("names");
        let video = dir.join("Replay.mp4");
        std::fs::write(&video, b"video").unwrap();
        for name in [
            "",
            "..",
            "../Replay.mp4",
            "a/b.mp4",
            "Replay.txt",
            "Replay",
            "con.mp4",
            "Replay.mp4.",
        ] {
            let error = rename_video(video.to_str().unwrap(), name, VIDEOS).unwrap_err();
            assert_eq!(error.code, "NAME_INVALID", "{name}");
        }
        assert!(video.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_videos_can_be_moved_or_renamed() {
        let dir = folder("only");
        let notes = dir.join("notes.txt");
        std::fs::write(&notes, b"keep").unwrap();
        assert!(trash_videos(&[notes.display().to_string()], VIDEOS).is_err());
        assert!(rename_video(notes.to_str().unwrap(), "notes.mp4", VIDEOS).is_err());
        assert!(trash_videos(&["relative.mp4".into()], VIDEOS).is_err());
        assert!(trash_videos(&[], VIDEOS).is_err());
        assert!(notes.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_video_already_gone_is_reported_not_failed() {
        let dir = folder("gone");
        let results = trash_videos(&[dir.join("Gone.mp4").display().to_string()], VIDEOS).unwrap();
        assert_eq!(results[0].outcome, TrashOutcome::Missing);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
