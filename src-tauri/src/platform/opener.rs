use std::path::{Path, PathBuf};

use crate::backend::protocol::PublicBackendError;

pub trait Opener: Send + Sync {
    fn open(&self, path: &Path) -> std::io::Result<()>;
    fn reveal(&self, path: &Path) -> std::io::Result<()>;
    /// opens a file in the app the system uses for its type
    fn launch(&self, path: &Path) -> std::io::Result<()>;
}

pub struct SystemOpener;

/// Ordered folder openers tried on Linux. `xdg-open` is the norm. The rest cover
/// minimal window-manager setups that ship a file manager but no `xdg-utils`.
#[cfg(target_os = "linux")]
const LINUX_FOLDER_OPENERS: &[&str] = &[
    "xdg-open", "gio", "nautilus", "dolphin", "nemo", "thunar", "pcmanfm", "caja",
];

#[cfg(target_os = "linux")]
fn host_command(program: &str) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    if let Some(appdir) = std::env::var_os("APPDIR") {
        clean_host_environment(&mut command, Path::new(&appdir), std::env::vars_os());
    }
    command
}

/// GStreamer settings the AppImage launcher and Tuck set for the bundled plugins.
/// The launcher replaces any value the user had, so host programs get none of them.
#[cfg(target_os = "linux")]
const BUNDLED_GSTREAMER_KEYS: &[&str] = &[
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_PATH_1_0",
    "GST_PLUGIN_SCANNER_1_0",
    "GST_PTP_HELPER_1_0",
    "GST_REGISTRY_1_0",
    "GST_REGISTRY_REUSE_PLUGIN_SCANNER",
];

#[cfg(target_os = "linux")]
fn clean_host_environment(
    command: &mut std::process::Command,
    appdir: &Path,
    environment: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) {
    // host programs must not load the AppImage's older libraries and plugins
    for (key, value) in environment {
        if key
            .to_str()
            .is_some_and(|key| BUNDLED_GSTREAMER_KEYS.contains(&key))
        {
            command.env_remove(key);
            continue;
        }
        if !matches!(
            key.to_str(),
            Some(
                "PATH"
                    | "LD_LIBRARY_PATH"
                    | "LD_PRELOAD"
                    | "XDG_DATA_DIRS"
                    | "GTK_PATH"
                    | "GIO_EXTRA_MODULES"
                    | "GIO_MODULE_DIR"
                    | "GTK_DATA_PREFIX"
                    | "GTK_EXE_PREFIX"
                    | "GSETTINGS_SCHEMA_DIR"
                    | "GTK_IM_MODULE_FILE"
                    | "GDK_PIXBUF_MODULE_FILE"
            )
        ) {
            continue;
        }
        let paths: Vec<_> = std::env::split_paths(&value).collect();
        let retained: Vec<_> = paths
            .iter()
            .filter(|path| !path.starts_with(appdir))
            .collect();
        if retained.len() == paths.len() {
            continue;
        }
        if retained.is_empty() {
            command.env_remove(key);
        } else if let Ok(value) = std::env::join_paths(retained) {
            command.env(key, value);
        }
    }
}

#[cfg(target_os = "linux")]
fn spawn_first_available(path: &Path, programs: &[&str]) -> std::io::Result<()> {
    let mut last_error: Option<std::io::Error> = None;
    for program in programs {
        let mut command = host_command(program);
        if *program == "gio" {
            command.arg("open");
        }
        command.arg(path);
        if matches!(*program, "xdg-open" | "gio") {
            match command.status() {
                Ok(status) if status.success() => return Ok(()),
                Ok(_) => last_error = Some(std::io::Error::other("folder opener failed")),
                Err(error) => last_error = Some(error),
            }
            continue;
        }
        match command.spawn() {
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

/// Only programs that hand a file to the user's default app; the folder openers above would show
/// the file in a file manager instead.
#[cfg(target_os = "linux")]
const LINUX_FILE_LAUNCHERS: &[&str] = &["xdg-open", "gio"];

/// How long a launcher gets to report that nothing can open the file.
#[cfg(target_os = "linux")]
const LAUNCH_CHECK: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg(target_os = "linux")]
fn launch_first_available(
    path: &Path,
    programs: &[&str],
    check: std::time::Duration,
) -> std::io::Result<()> {
    let mut last_error: Option<std::io::Error> = None;
    for program in programs {
        let mut command = host_command(program);
        if *program == "gio" {
            command.arg("open");
        }
        command.arg(path);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        // without a desktop environment xdg-open runs the player itself and only returns when it
        // closes, so a launcher still running after the check counts as opened
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut child = child;
        std::thread::spawn(move || {
            let _ = sender.send(child.wait());
        });
        match receiver.recv_timeout(check) {
            Ok(Ok(status)) if !status.success() => {
                last_error = Some(std::io::Error::other("file opener failed"));
            }
            _ => return Ok(()),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no program is available to open the file",
        )
    }))
}

/// The path without the extended-length prefix (`\\?\C:\...`, `\\?\UNC\server\share\...`) that
/// canonical paths carry on Windows, such as files sent to Tuck on its command line. Explorer
/// doesn't take that form, so a path handed to it is written the ordinary way.
#[cfg(target_os = "windows")]
fn explorer_path(path: &Path) -> PathBuf {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_path_buf();
    };
    let mut plain = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
        Prefix::VerbatimUNC(server, share) => {
            let mut root = std::ffi::OsString::from(r"\\");
            root.push(server);
            root.push(r"\");
            root.push(share);
            root.push(r"\");
            PathBuf::from(root)
        }
        _ => return path.to_path_buf(),
    };
    for component in components {
        if component != Component::RootDir {
            plain.push(component);
        }
    }
    plain
}

impl Opener for SystemOpener {
    fn reveal(&self, path: &Path) -> std::io::Result<()> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;

            // keep Explorer's switch separate from the quoted file path
            std::process::Command::new("explorer.exe")
                .raw_arg("/select,")
                .arg(explorer_path(path))
                .spawn()
                .map(|_| ())
        }
        #[cfg(target_os = "linux")]
        {
            let uri = tauri::Url::from_file_path(path).map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid file path")
            })?;
            // commas delimit dbus-send arrays, so escape them inside the file URI
            let reply = host_command("dbus-send")
                .args([
                    "--session",
                    "--dest=org.freedesktop.FileManager1",
                    "--print-reply",
                    "--reply-timeout=5000",
                    "/org/freedesktop/FileManager1",
                    "org.freedesktop.FileManager1.ShowItems",
                ])
                .arg(format!("array:string:{}", uri.as_str().replace(',', "%2C")))
                .arg("string:")
                .output();
            if matches!(reply, Ok(output) if output.status.success()) {
                return Ok(());
            }
            // minimal desktops may not expose the file-selection interface
            self.open(path.parent().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
            })?)
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "unsupported platform",
            ))
        }
    }

    fn open(&self, path: &Path) -> std::io::Result<()> {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg(explorer_path(path))
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

    fn launch(&self, path: &Path) -> std::io::Result<()> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;

            // Explorer opens a file in its default app; it also splits arguments at commas, so
            // the path goes in quotes, which a Windows path can never contain
            let mut quoted = std::ffi::OsString::from("\"");
            quoted.push(explorer_path(path).as_os_str());
            quoted.push("\"");
            std::process::Command::new("explorer.exe")
                .raw_arg(quoted)
                .spawn()
                .map(|_| ())
        }
        #[cfg(target_os = "linux")]
        {
            launch_first_available(path, LINUX_FILE_LAUNCHERS, LAUNCH_CHECK)
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

pub fn open_with_validation(path_str: &str, opener: &dyn Opener) -> Result<(), PublicBackendError> {
    let path = validate_path_for_open(path_str)?;
    if !path.exists() {
        return Err(PublicBackendError::new(
            "INVALID_PATH",
            "The export could not be found. It may have been moved or deleted.",
        ));
    }
    let result = if path.is_dir() {
        opener.open(&path)
    } else {
        opener.reveal(&path)
    };
    result.map_err(|_| {
        PublicBackendError::new(
            "UNSUPPORTED_OPERATION",
            "Could not show the export in its folder.",
        )
    })
}

/// Opens a finished export in the system's default app. The caller has already checked that the
/// path is an export the backend finished.
pub fn launch_export(path: &Path, opener: &dyn Opener) -> Result<(), PublicBackendError> {
    opener.launch(path).map_err(|_| {
        PublicBackendError::new(
            "UNSUPPORTED_OPERATION",
            "No app opened the file. Use Show in folder instead.",
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
        pub revealed: std::sync::Mutex<Vec<PathBuf>>,
        pub launched: std::sync::Mutex<Vec<PathBuf>>,
        pub should_fail: bool,
    }

    impl MockOpener {
        fn new(should_fail: bool) -> Self {
            Self {
                called: std::sync::Mutex::new(Vec::new()),
                revealed: std::sync::Mutex::new(Vec::new()),
                launched: std::sync::Mutex::new(Vec::new()),
                should_fail,
            }
        }
    }

    impl Opener for MockOpener {
        fn reveal(&self, path: &Path) -> std::io::Result<()> {
            self.revealed.lock().unwrap().push(path.to_path_buf());
            if self.should_fail {
                Err(std::io::Error::other("mock failure"))
            } else {
                Ok(())
            }
        }

        fn open(&self, path: &Path) -> std::io::Result<()> {
            self.called.lock().unwrap().push(path.to_path_buf());
            if self.should_fail {
                Err(std::io::Error::other("mock failure"))
            } else {
                Ok(())
            }
        }

        fn launch(&self, path: &Path) -> std::io::Result<()> {
            self.launched.lock().unwrap().push(path.to_path_buf());
            if self.should_fail {
                Err(std::io::Error::other("mock failure"))
            } else {
                Ok(())
            }
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn explorer_gets_paths_without_the_extended_length_prefix() {
        assert_eq!(
            explorer_path(Path::new(r"\\?\X:\Videos\a, b\clip.mp4")),
            PathBuf::from(r"X:\Videos\a, b\clip.mp4")
        );
        assert_eq!(
            explorer_path(Path::new(r"\\?\UNC\server\share\Videos\clip.mp4")),
            PathBuf::from(r"\\server\share\Videos\clip.mp4")
        );
        assert_eq!(
            explorer_path(Path::new(r"C:\Videos\clip.mp4")),
            PathBuf::from(r"C:\Videos\clip.mp4")
        );
        // the export a launch from Send To finishes keeps its source's canonical form
        let canonical = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        assert!(!explorer_path(&canonical)
            .to_string_lossy()
            .starts_with(r"\\?\"));
        assert!(explorer_path(&canonical).is_dir());
    }

    #[test]
    fn launching_an_export_uses_the_default_app_and_never_the_folder() {
        let file = std::env::temp_dir().join("tuck-launch-export.mp4");
        let mock = MockOpener::new(false);
        assert!(launch_export(&file, &mock).is_ok());
        assert_eq!(*mock.launched.lock().unwrap(), vec![file]);
        assert!(mock.called.lock().unwrap().is_empty());
        assert!(mock.revealed.lock().unwrap().is_empty());
    }

    #[test]
    fn a_failed_launch_points_at_show_in_folder() {
        let mock = MockOpener::new(true);
        let error = launch_export(Path::new("/tmp/a.mp4"), &mock).unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_OPERATION");
        assert!(error.message.contains("Show in folder"));
    }

    #[test]
    fn valid_output_path_reveals_file() {
        let dir = std::env::temp_dir().join("tuck_opener_valid");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("output.mp4");
        std::fs::write(&file, b"").unwrap();
        let mock = MockOpener::new(false);
        let result = open_with_validation(&file.to_string_lossy(), &mock);
        assert!(result.is_ok());
        assert!(mock.called.lock().unwrap().is_empty());
        assert_eq!(*mock.revealed.lock().unwrap(), vec![file.clone()]);
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn missing_output_is_rejected_before_opener() {
        let file = std::env::temp_dir().join("tuck-missing-output-12345.mp4");
        let mock = MockOpener::new(false);
        let result = open_with_validation(&file.to_string_lossy(), &mock);
        assert_eq!(result.unwrap_err().code, "INVALID_PATH");
        assert!(mock.called.lock().unwrap().is_empty());
        assert!(mock.revealed.lock().unwrap().is_empty());
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
    fn external_commands_use_host_libraries_and_keep_session_settings() {
        use std::ffi::OsString;
        let mut command = std::process::Command::new("/usr/bin/env");
        command.env_clear();
        let environment = [
            ("LD_LIBRARY_PATH", "/tmp/Tuck/usr/lib:/opt/host/lib"),
            ("PATH", "/tmp/Tuck/usr/bin:/usr/bin"),
            ("GIO_MODULE_DIR", "/tmp/Tuck/usr/lib/gio/modules"),
            ("XDG_DATA_DIRS", "/tmp/Tuck/usr/share:/usr/share"),
            (
                "GST_PLUGIN_SYSTEM_PATH_1_0",
                "/home/a/.cache/com.tuck.app/gstreamer/plugins",
            ),
            (
                "GST_REGISTRY_1_0",
                "/home/a/.cache/com.tuck.app/gstreamer/registry.bin",
            ),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("DISPLAY", ":1"),
        ]
        .map(|(key, value)| (OsString::from(key), OsString::from(value)));
        command.envs(environment.clone());
        clean_host_environment(&mut command, Path::new("/tmp/Tuck"), environment);
        let output = command.output().unwrap();
        assert!(output.status.success());
        let output = String::from_utf8(output.stdout).unwrap();
        assert!(!output.contains("/tmp/Tuck"));
        assert!(output.contains("LD_LIBRARY_PATH=/opt/host/lib\n"));
        assert!(output.contains("PATH=/usr/bin\n"));
        assert!(output.contains("XDG_DATA_DIRS=/usr/share\n"));
        assert!(output.contains("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus\n"));
        assert!(output.contains("DISPLAY=:1\n"));
        assert!(!output.contains("GIO_MODULE_DIR="));
        assert!(!output.contains("GST_"));
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
    fn linux_file_launchers_open_the_default_app_rather_than_a_file_manager() {
        assert_eq!(LINUX_FILE_LAUNCHERS, &["xdg-open", "gio"]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_moves_on_from_a_launcher_that_fails_or_is_missing() {
        let short = std::time::Duration::from_secs(5);
        launch_first_available(
            &std::env::temp_dir(),
            &["tuck-no-such-launcher-xyz", "false", "true"],
            short,
        )
        .expect("should fall through to `true`");
        let error = launch_first_available(&std::env::temp_dir(), &["false"], short).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_launcher_still_running_after_the_check_counts_as_opened() {
        // `sleep` keeps running past the check, the way xdg-open does when it runs the player itself
        let started = std::time::Instant::now();
        launch_first_available(
            Path::new("5"),
            &["sleep"],
            std::time::Duration::from_millis(200),
        )
        .expect("a launcher that is still running has opened the file");
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
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
