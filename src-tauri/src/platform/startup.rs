use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

const TASK_FLAG: &str = "--sendto-task";
// the argument after these flags is a value, never a media file
const VALUE_FLAGS: [&str; 3] = [TASK_FLAG, "--sendto-action", "--profile-id"];

/// Export task a Send To shortcut asks the editor to open with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchTask {
    Compression,
    Upscale,
    Cut,
}

impl LaunchTask {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "compression" => Some(Self::Compression),
            "upscale" => Some(Self::Upscale),
            "cut" => Some(Self::Cut),
            _ => None,
        }
    }
}

/// What one launch hands to the editor. Serializes as `{ files, task }` for
/// `get_startup_files` and the "second-instance" event.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StartupLaunch {
    pub files: Vec<String>,
    pub task: Option<LaunchTask>,
}

impl StartupLaunch {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.task.is_none()
    }

    /// Append a later launch: its files follow these, and its task wins when it names one.
    pub fn merge(&mut self, later: StartupLaunch) {
        self.files.extend(later.files);
        if later.task.is_some() {
            self.task = later.task;
        }
    }
}

/// Read startup arguments: keep files that exist (deduplicated by canonical
/// path, in first-seen order) and a known `--sendto-task` value. Other flags
/// and unknown task values are ignored; Python validates the files again.
pub fn parse_startup_args(args: Vec<String>) -> StartupLaunch {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut launch = StartupLaunch::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if VALUE_FLAGS.contains(&arg.as_str()) {
            let value = args.next();
            if arg == TASK_FLAG {
                if let Some(task) = value.as_deref().and_then(LaunchTask::parse) {
                    launch.task = Some(task);
                }
            }
            continue;
        }
        // skip flags like --sendto-files
        if arg.starts_with('-') {
            continue;
        }
        push_existing_file(&mut seen, &mut launch.files, &arg);
    }
    launch
}

fn push_existing_file(seen: &mut HashSet<PathBuf>, files: &mut Vec<String>, arg: &str) {
    let trimmed = arg.trim();
    if trimmed.is_empty() {
        return;
    }
    let path = Path::new(trimmed);
    // canonical paths deduplicate the same file reached through different spellings
    if let Ok(canonical) = path.canonicalize() {
        if canonical.is_file() && seen.insert(canonical.clone()) {
            files.push(canonical.to_string_lossy().to_string());
        }
    } else if path.is_file() {
        if let Ok(canonical) = std::fs::canonicalize(path) {
            if seen.insert(canonical.clone()) {
                files.push(canonical.to_string_lossy().to_string());
            }
        } else if seen.insert(path.to_path_buf()) {
            files.push(trimmed.to_owned());
        }
    }
}

/// Validate that startup files are ready to deliver: at least one normalized path.
pub fn startup_files_ready(files: &[String]) -> bool {
    !files.is_empty()
}

/// Simulated second-instance delivery: parse args, then attempt to send to primary via injected sender.
/// A launch needs files or a task; returns Err with a code otherwise or when sending fails.
pub fn deliver_second_instance_args<F>(args: Vec<String>, sender: F) -> Result<(), String>
where
    F: Fn(StartupLaunch) -> Result<(), String>,
{
    let launch = parse_startup_args(args);
    if launch.is_empty() {
        return Err("SECOND_INSTANCE_NO_FILES".to_owned());
    }
    sender(launch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn temp_file(dir: &str, name: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(dir);
        let _ = fs::create_dir_all(&dir);
        let file = dir.join(name);
        fs::write(&file, b"").unwrap();
        let canonical = fs::canonicalize(&file)
            .unwrap()
            .to_string_lossy()
            .to_string();
        (file, canonical)
    }

    fn arg(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn normalizes_existing_files_and_deduplicates() {
        let (file1, canonical1) = temp_file("tuck_startup_test", "a.mp4");
        let (file2, canonical2) = temp_file("tuck_startup_test", "b.mp4");

        let args = vec![
            arg(&file1),
            "--sendto-files".to_owned(),
            arg(&file2),
            arg(&file1), // duplicate
            "nonexistent.mp4".to_owned(),
        ];
        let out = parse_startup_args(args);
        assert_eq!(out.files, vec![canonical1, canonical2]);
        assert_eq!(out.task, None);
    }

    #[test]
    fn empty_args_normalize_to_empty() {
        let out = parse_startup_args(vec!["--sendto-files".to_owned(), "".to_owned()]);
        assert!(out.is_empty());
    }

    #[test]
    fn captures_the_task_after_its_flag() {
        let (file, canonical) = temp_file("tuck_startup_task", "clip.mp4");
        let out = parse_startup_args(vec![
            "--sendto-action".to_owned(),
            "review".to_owned(),
            "--sendto-task".to_owned(),
            "cut".to_owned(),
            "--sendto-files".to_owned(),
            arg(&file),
        ]);
        assert_eq!(
            out,
            StartupLaunch {
                files: vec![canonical],
                task: Some(LaunchTask::Cut),
            }
        );
        for (value, task) in [
            ("compression", LaunchTask::Compression),
            ("upscale", LaunchTask::Upscale),
        ] {
            let out = parse_startup_args(vec!["--sendto-task".to_owned(), value.to_owned()]);
            assert_eq!(out.task, Some(task));
            assert!(out.files.is_empty());
        }
    }

    #[test]
    fn unknown_task_is_ignored() {
        for value in ["trim", "Cut", "", "--sendto-files"] {
            let out = parse_startup_args(vec!["--sendto-task".to_owned(), value.to_owned()]);
            assert!(out.is_empty(), "{value:?} must not become a task");
        }
    }

    #[test]
    fn flag_values_are_never_files() {
        let (value_file, _) = temp_file("tuck_startup_values", "cut");
        let (media, canonical) = temp_file("tuck_startup_values", "clip.mp4");
        for flag in ["--sendto-task", "--sendto-action", "--profile-id"] {
            let out = parse_startup_args(vec![flag.to_owned(), arg(&value_file), arg(&media)]);
            assert_eq!(
                out.files,
                vec![canonical.clone()],
                "{flag} value became a file"
            );
            assert_eq!(out.task, None);
        }
    }

    #[test]
    fn other_flags_are_still_dropped() {
        let (file, canonical) = temp_file("tuck_startup_flags", "clip.mp4");
        let out = parse_startup_args(vec!["--verbose".to_owned(), arg(&file), "-x".to_owned()]);
        assert_eq!(out.files, vec![canonical]);
        assert_eq!(out.task, None);
    }

    #[test]
    fn launch_serializes_files_and_task_for_the_frontend() {
        assert_eq!(
            serde_json::to_value(StartupLaunch::default()).unwrap(),
            json!({ "files": [], "task": null })
        );
        assert_eq!(
            serde_json::to_value(StartupLaunch {
                files: vec!["a.mp4".to_owned()],
                task: Some(LaunchTask::Upscale),
            })
            .unwrap(),
            json!({ "files": ["a.mp4"], "task": "upscale" })
        );
    }

    #[test]
    fn merge_keeps_file_order_and_the_latest_task() {
        let mut launch = StartupLaunch {
            files: vec!["a.mp4".to_owned()],
            task: Some(LaunchTask::Cut),
        };
        launch.merge(StartupLaunch {
            files: vec!["b.mp4".to_owned()],
            task: None,
        });
        assert_eq!(launch.task, Some(LaunchTask::Cut));
        launch.merge(StartupLaunch {
            files: Vec::new(),
            task: Some(LaunchTask::Upscale),
        });
        assert_eq!(launch.files, vec!["a.mp4", "b.mp4"]);
        assert_eq!(launch.task, Some(LaunchTask::Upscale));
    }

    #[test]
    fn second_instance_fails_without_files_or_task() {
        let result = deliver_second_instance_args(vec!["--flag".to_owned()], |_| Ok(()));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "SECOND_INSTANCE_NO_FILES");
    }

    #[test]
    fn second_instance_delivers_a_task_without_files() {
        let result = deliver_second_instance_args(
            vec!["--sendto-task".to_owned(), "upscale".to_owned()],
            |launch| {
                assert!(launch.files.is_empty());
                assert_eq!(launch.task, Some(LaunchTask::Upscale));
                Ok(())
            },
        );
        assert!(result.is_ok());
    }

    #[test]
    fn second_instance_delivers_via_sender() {
        let (file, _) = temp_file("tuck_second_instance", "c.mp4");
        let result = deliver_second_instance_args(vec![arg(&file)], |launch| {
            assert_eq!(launch.files.len(), 1);
            Ok(())
        });
        assert!(result.is_ok());
    }

    #[test]
    fn second_instance_reports_sender_failure() {
        let (file, _) = temp_file("tuck_second_fail", "d.mp4");
        let result = deliver_second_instance_args(vec![arg(&file)], |_| {
            Err("PRIMARY_UNAVAILABLE".to_owned())
        });
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "PRIMARY_UNAVAILABLE");
    }
}
