use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Normalize startup arguments: extract file paths that exist and are files,
/// deduplicate by canonical path, preserve order of first appearance.
/// Invalid or non-file arguments are silently ignored (Python will validate).
pub fn normalize_startup_args(args: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut result: Vec<String> = Vec::new();
    for arg in args {
        // skip flags like --sendto-files, --profile-id, etc
        if arg.starts_with('-') {
            continue;
        }
        // Skip empty
        let trimmed = arg.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = Path::new(trimmed);
        // only consider absolute or relative paths that exist as files
        // use canonicalize to deduplicate
        if let Ok(canonical) = path.canonicalize() {
            if canonical.is_file() && seen.insert(canonical.clone()) {
                result.push(canonical.to_string_lossy().to_string());
            } else if !canonical.is_file() {
                // If canonical is not a file, ignore
            }
        } else {
            // If canonicalize fails, check if original path exists as file (maybe not canonical)
            if path.is_file() {
                if let Ok(canonical2) = std::fs::canonicalize(path) {
                    if seen.insert(canonical2.clone()) {
                        result.push(canonical2.to_string_lossy().to_string());
                    }
                } else if seen.insert(path.to_path_buf()) {
                    result.push(trimmed.to_owned());
                }
            }
        }
    }
    result
}

/// Validate that startup files are ready to deliver: at least one normalized path.
pub fn startup_files_ready(files: &[String]) -> bool {
    !files.is_empty()
}

/// Simulated second-instance delivery: normalize args, then attempt to send to primary via injected sender.
/// Returns Ok(()) if delivered, Err with code if failed.
pub fn deliver_second_instance_args<F>(args: Vec<String>, sender: F) -> Result<(), String>
where
    F: Fn(Vec<String>) -> Result<(), String>,
{
    let files = normalize_startup_args(args);
    if files.is_empty() {
        return Err("SECOND_INSTANCE_NO_FILES".to_owned());
    }
    sender(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn normalizes_existing_files_and_deduplicates() {
        let dir = std::env::temp_dir().join("tuck_startup_test");
        let _ = fs::create_dir_all(&dir);
        let file1 = dir.join("a.mp4");
        let file2 = dir.join("b.mp4");
        fs::write(&file1, b"").unwrap();
        fs::write(&file2, b"").unwrap();
        let canonical1 = fs::canonicalize(&file1)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let canonical2 = fs::canonicalize(&file2)
            .unwrap()
            .to_string_lossy()
            .to_string();

        let args = vec![
            file1.to_string_lossy().to_string(),
            "--sendto-files".to_owned(),
            file2.to_string_lossy().to_string(),
            file1.to_string_lossy().to_string(), // duplicate
            "nonexistent.mp4".to_owned(),
        ];
        let out = normalize_startup_args(args);
        assert_eq!(out.len(), 2);
        assert!(out.contains(&canonical1));
        assert!(out.contains(&canonical2));
        let _ = fs::remove_file(&file1);
        let _ = fs::remove_file(&file2);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn empty_args_normalize_to_empty() {
        let out = normalize_startup_args(vec!["--sendto-files".to_owned(), "".to_owned()]);
        assert!(out.is_empty());
    }

    #[test]
    fn second_instance_fails_without_files() {
        let result = deliver_second_instance_args(vec!["--flag".to_owned()], |_| Ok(()));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "SECOND_INSTANCE_NO_FILES");
    }

    #[test]
    fn second_instance_delivers_via_sender() {
        let dir = std::env::temp_dir().join("tuck_second_instance");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("c.mp4");
        fs::write(&file, b"").unwrap();
        let result =
            deliver_second_instance_args(vec![file.to_string_lossy().to_string()], |files| {
                assert_eq!(files.len(), 1);
                Ok(())
            });
        assert!(result.is_ok());
        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn second_instance_reports_sender_failure() {
        let dir = std::env::temp_dir().join("tuck_second_fail");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("d.mp4");
        fs::write(&file, b"").unwrap();
        let result = deliver_second_instance_args(vec![file.to_string_lossy().to_string()], |_| {
            Err("PRIMARY_UNAVAILABLE".to_owned())
        });
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "PRIMARY_UNAVAILABLE");
        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&dir);
    }
}
