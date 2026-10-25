//! Whether the user wants Hardware playback, the native player. The shell keeps it beside its
//! window state instead of in the backend's settings, because it is needed before the window
//! system starts: on Linux the native player decides GTK's backend, long before Python runs.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::platform::APP_IDENTIFIER;

const FILE_NAME: &str = "preview.json";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    version: u32,
    hardware_playback: bool,
}

/// Tauri's app local data folder, worked out from the environment because Tauri isn't running
/// yet when the choice is first read: `%LOCALAPPDATA%` on Windows, `$XDG_DATA_HOME` or
/// `~/.local/share` on Linux.
fn data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute());
    #[cfg(not(windows))]
    let base = match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => Some(dir),
        _ => std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(|home| PathBuf::from(home).join(".local/share")),
    };
    Some(base?.join(APP_IDENTIFIER))
}

fn file() -> Option<PathBuf> {
    Some(data_dir()?.join(FILE_NAME))
}

/// The saved choice, on when nothing was saved yet or the file can't be read.
pub fn hardware_playback() -> bool {
    file().as_deref().is_none_or(read)
}

/// The choice this run started with; a change saved since applies after a restart.
pub fn hardware_playback_at_start() -> bool {
    static AT_START: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AT_START.get_or_init(hardware_playback)
}

fn read(file: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else {
        return true;
    };
    match serde_json::from_str::<Saved>(&text) {
        Ok(saved) if saved.version == FORMAT_VERSION => saved.hardware_playback,
        _ => {
            eprintln!("ignoring an unreadable Hardware playback choice");
            true
        }
    }
}

pub fn save_hardware_playback(on: bool) -> std::io::Result<()> {
    let file = file().ok_or_else(|| std::io::Error::other("no folder for Tuck's own data"))?;
    write(&file, on)
}

fn write(file: &Path, on: bool) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let saved = Saved {
        version: FORMAT_VERSION,
        hardware_playback: on,
    };
    let text = serde_json::to_vec_pretty(&saved).map_err(std::io::Error::other)?;
    // a crash while writing leaves the previous choice whole
    let temporary = file.with_extension("json.tmp");
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_file(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tuck-preference-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("nested").join(FILE_NAME)
    }

    #[test]
    fn hardware_playback_is_on_until_turned_off() {
        let file = test_file("default");
        assert!(read(&file), "nothing saved yet");
        write(&file, false).expect("saved");
        assert!(!read(&file));
        assert!(!file.with_extension("json.tmp").exists());
        write(&file, true).expect("saved again");
        assert!(read(&file));
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn an_unreadable_or_newer_choice_counts_as_on() {
        let file = test_file("unreadable");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{ not json").unwrap();
        assert!(read(&file));
        std::fs::write(&file, r#"{"version":2,"hardwarePlayback":false}"#).unwrap();
        assert!(read(&file), "a later Tuck's file is not guessed at");
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn the_choice_lives_in_tuck_own_data_folder() {
        let file = file().expect("a data folder in tests");
        assert!(file.ends_with(Path::new(APP_IDENTIFIER).join(FILE_NAME)));
    }
}
