use std::path::{Path, PathBuf};

use crate::backend::protocol::PublicBackendError;

pub trait Opener: Send + Sync {
    fn open(&self, path: &Path) -> std::io::Result<()>;
}

pub struct SystemOpener;

/// Ordered folder openers tried on Linux. `xdg-open` is the norm. The rest cover
/// minimal window-manager setups that ship a file manager but no `xdg-utils`.
#[cfg(target_os = "linux")]
const LINUX_FOLDER_OPENERS: &[&str] = &[
    "xdg-open", "gio", "nautilus", "dolphin", "nemo", "thunar", "pcmanfm", "caja",
];

#[cfg(target_os = "linux")]
fn spawn_first_available(path: &Path, programs: &[&str]) -> std::io::Result<()> {
    let mut last_error: Option<std::io::Error> = None;
    for program in programs {
        let mut command = std::process::Command::new(program);
        if *program == "gio" {
            command.arg("open");
        }
        match command.arg(path).spawn() {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no file manager is available to open the folder",
        )
    }))
}

impl Opener for SystemOpener {
    fn open(&self, path: &Path) -> std::io::Result<()> {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg(path)
                .spawn()
                .map(|_| ())
        }
        #[cfg(target_os = "linux")]
        {
            spawn_first_available(path, LINUX_FOLDER_OPENERS)
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "unsupported platform",
            ))
        }
    }
}

pub fn validate_path_for_open(path_str: &str) -> Result<PathBuf, PublicBackendError> {
    if path_str.trim().is_empty() {
        return Err(PublicBackendError::new(
            "INVALID_PATH",
            "Path must be a non-empty string.",
        ));
    }
    if path_str.contains('\0') {
        return Err(PublicBackendError::new(
            "INVALID_PATH",
            "Path contains invalid characters.",
        ));
    }
    let path = PathBuf::from(path_str);
    if !path.is_absolute() {
        // Allow relative but warn; for privileged open we require absolute or existing file
        // We enforce absolute for security: must be absolute path
        return Err(PublicBackendError::new(
            "INVALID_PATH",
            "Path must be absolute.",
        ));
    }
    // Parent must exist
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            return Err(PublicBackendError::new(
                "INVALID_PATH",
                "Parent directory does not exist.",
            ));
        }
    }
    Ok(path)
}

pub fn validate_output_path_and_get_folder(path_str: &str) -> Result<PathBuf, PublicBackendError> {
    let path = validate_path_for_open(path_str)?;
    // For open_output_folder, path is a file path; we need its parent folder
    // If path itself is a directory, open it directly if exists
    if path.is_dir() {
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        if parent.exists() || parent == Path::new("") {
            // If file parent exists, open the parent
            // If path is just a file name with no parent, treat as invalid
            if parent.as_os_str().is_empty() {
                return Err(PublicBackendError::new(
                    "INVALID_PATH",
                    "Path has no parent directory.",
                ));
            }
            return Ok(parent.to_path_buf());
        }
    }
    Err(PublicBackendError::new(
        "INVALID_PATH",
        "Cannot determine parent folder for path.",
    ))
}

pub fn open_with_validation(path_str: &str, opener: &dyn Opener) -> Result<(), PublicBackendError> {
    let folder = validate_output_path_and_get_folder(path_str)?;
    opener.open(&folder).map_err(|_| {
        PublicBackendError::new(
            "UNSUPPORTED_OPERATION",
            "Could not open folder with system opener.",
        )
    })
}

pub fn open_app_folder_with_validation(
    folder: &Path,
    opener: &dyn Opener,
) -> Result<(), PublicBackendError> {
    if !folder.exists() {
        // Try to create
        if std::fs::create_dir_all(folder).is_err() {
            return Err(PublicBackendError::new(
                "INVALID_PATH",
                "Could not create folder.",
            ));
        }
    }
    opener
        .open(folder)
        .map_err(|_| PublicBackendError::new("UNSUPPORTED_OPERATION", "Could not open folder."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    struct MockOpener {
        pub called: std::sync::Mutex<Vec<PathBuf>>,
        pub should_fail: bool,
    }

    impl MockOpener {
        fn new(should_fail: bool) -> Self {
            Self {
                called: std::sync::Mutex::new(Vec::new()),
                should_fail,
            }
        }
    }

    impl Opener for MockOpener {
        fn open(&self, path: &Path) -> std::io::Result<()> {
            self.called.lock().unwrap().push(path.to_path_buf());
            if self.should_fail {
                Err(std::io::Error::other("mock failure"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn valid_output_path_opens_parent_folder() {
        let dir = std::env::temp_dir().join("tuck_opener_valid");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("output.mp4");
        std::fs::write(&file, b"").unwrap();
        let mock = MockOpener::new(false);
        let result = open_with_validation(&file.to_string_lossy(), &mock);
        assert!(result.is_ok());
        assert_eq!(mock.called.lock().unwrap().len(), 1);
        assert_eq!(mock.called.lock().unwrap()[0], dir);
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn empty_path_is_rejected_before_opener() {
        let mock = MockOpener::new(false);
        let result = open_with_validation("", &mock);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "INVALID_PATH");
        assert!(mock.called.lock().unwrap().is_empty());
    }

    #[test]
    fn relative_path_is_rejected() {
        let mock = MockOpener::new(false);
        let result = open_with_validation("relative/path.mp4", &mock);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "INVALID_PATH");
        assert!(mock.called.lock().unwrap().is_empty());
    }

    #[test]
    fn null_byte_is_rejected() {
        let mock = MockOpener::new(false);
        let result = open_with_validation("/tmp/foo\0bar.mp4", &mock);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "INVALID_PATH");
    }

    #[test]
    fn opener_failure_maps_to_unsupported_operation() {
        let dir = std::env::temp_dir().join("tuck_opener_fail");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("a.mp4");
        std::fs::write(&file, b"").unwrap();
        let mock = MockOpener::new(true);
        let result = open_with_validation(&file.to_string_lossy(), &mock);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "UNSUPPORTED_OPERATION");
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn injected_opener_receives_correct_path() {
        let dir = std::env::temp_dir().join("tuck_opener_injected");
        let _ = std::fs::create_dir_all(&dir);
        let mock = MockOpener::new(false);
        let result = open_app_folder_with_validation(&dir, &mock);
        assert!(result.is_ok());
        assert_eq!(mock.called.lock().unwrap()[0], dir);
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_folder_openers_try_xdg_open_first() {
        assert_eq!(LINUX_FOLDER_OPENERS.first(), Some(&"xdg-open"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn spawn_first_available_falls_through_a_missing_program() {
        // `true` exists on every POSIX system, so the bogus name before it must be skipped
        spawn_first_available(&std::env::temp_dir(), &["tuck-no-such-opener-xyz", "true"])
            .expect("should fall through to `true`");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn spawn_first_available_reports_when_nothing_is_installed() {
        let error =
            spawn_first_available(&std::env::temp_dir(), &["tuck-no-such-a", "tuck-no-such-b"])
                .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
}
