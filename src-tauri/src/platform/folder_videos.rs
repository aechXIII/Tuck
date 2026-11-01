//! The videos inside folders that were dropped on Tuck or chosen with Add a folder.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// A folder can hold far more than the Library is meant for (a whole drive dropped by mistake),
/// so the walk stops at this many videos and the page says the list was cut short.
pub const MAX_VIDEOS: usize = 1000;
// a drive full of documents has no videos to stop at, so the walk also stops after this many
// entries rather than reading the whole disk
const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct FolderVideos {
    /// the given paths that are folders, in the order given
    pub folders: Vec<String>,
    /// their videos, each folder's own files first and then its subfolders, sorted by name the
    /// way a file manager sorts them
    pub videos: Vec<String>,
    /// true when the walk stopped early, so there may be more videos than listed
    pub truncated: bool,
}

struct Walk<'a> {
    extensions: &'a [&'a str],
    result: FolderVideos,
    entries: usize,
}

/// Lists the videos under each given path that is a folder. Paths that aren't folders are left
/// out of the result, so the caller can tell a dropped folder from a dropped file. Symlinked
/// folders aren't followed (a link to a parent would loop), and hidden folders are skipped.
pub fn folder_videos(paths: &[String], extensions: &[&str]) -> FolderVideos {
    let mut walk = Walk {
        extensions,
        result: FolderVideos::default(),
        entries: 0,
    };
    for path in paths {
        let folder = Path::new(path);
        if !std::fs::metadata(folder).is_ok_and(|metadata| metadata.is_dir()) {
            continue;
        }
        walk.result.folders.push(path.clone());
        if !walk.result.truncated {
            walk.visit(folder, 0);
        }
    }
    walk.result
}

impl Walk<'_> {
    fn visit(&mut self, folder: &Path, depth: usize) {
        let Ok(read) = std::fs::read_dir(folder) else {
            // a folder that can't be read (no permission) adds nothing, like an empty one
            return;
        };
        let mut files: Vec<PathBuf> = Vec::new();
        let mut folders: Vec<PathBuf> = Vec::new();
        for entry in read.flatten() {
            self.entries += 1;
            if self.entries > MAX_ENTRIES {
                self.result.truncated = true;
                return;
            }
            let path = entry.path();
            if is_hidden(&entry) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                folders.push(path);
            } else if self.is_video(&path)
                && (kind.is_file() || std::fs::metadata(&path).is_ok_and(|meta| meta.is_file()))
            {
                files.push(path);
            }
        }
        files.sort_by(|a, b| natural_order(file_name(a), file_name(b)));
        folders.sort_by(|a, b| natural_order(file_name(a), file_name(b)));
        for file in files {
            if self.result.videos.len() >= MAX_VIDEOS {
                self.result.truncated = true;
                return;
            }
            if let Some(text) = file.to_str() {
                self.result.videos.push(text.to_owned());
            }
        }
        if depth >= MAX_DEPTH {
            return;
        }
        for sub in folders {
            if self.result.truncated {
                return;
            }
            self.visit(&sub, depth + 1);
        }
    }

    fn is_video(&self, path: &Path) -> bool {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                self.extensions
                    .contains(&extension.to_ascii_lowercase().as_str())
            })
    }
}

fn file_name(path: &Path) -> &str {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
}

// dot names are hidden on Linux; Windows marks hidden and system folders such as
// "$RECYCLE.BIN" and "System Volume Information" with attributes instead
fn is_hidden(entry: &std::fs::DirEntry) -> bool {
    if entry.file_name().to_string_lossy().starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if entry
            .metadata()
            .is_ok_and(|metadata| metadata.file_attributes() & (HIDDEN | SYSTEM) != 0)
        {
            return true;
        }
    }
    false
}

/// Orders names the way Explorer and file managers do: case doesn't matter and runs of digits
/// compare as numbers, so "Clip 2" comes before "Clip 10".
pub fn natural_order(a: &str, b: &str) -> Ordering {
    let mut left = a.chars().peekable();
    let mut right = b.chars().peekable();
    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let first = take_number(&mut left);
                let second = take_number(&mut right);
                let order = first
                    .trim_start_matches('0')
                    .len()
                    .cmp(&second.trim_start_matches('0').len())
                    .then_with(|| {
                        first
                            .trim_start_matches('0')
                            .cmp(second.trim_start_matches('0'))
                    });
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                left.next();
                right.next();
            }
        }
    }
}

fn take_number(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut digits = String::new();
    while let Some(digit) = chars.next_if(char::is_ascii_digit) {
        digits.push(digit);
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIDEO: &[&str] = &["mp4", "mkv"];

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("tuck-folder-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    fn names(root: &Path, videos: &[String]) -> Vec<String> {
        videos
            .iter()
            .map(|video| {
                Path::new(video)
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn lists_videos_in_subfolders_after_the_folders_own() {
        let root = scratch("order");
        for name in [
            "Clip 10.mp4",
            "clip 2.MKV",
            "notes.txt",
            "b/Replay.mp4",
            "a/2/x.mp4",
            "a/one.mp4",
            ".thumbs/hidden.mp4",
        ] {
            touch(&root.join(name));
        }
        let found = folder_videos(&[root.to_string_lossy().into_owned()], VIDEO);
        assert_eq!(
            names(&root, &found.videos),
            [
                "clip 2.MKV",
                "Clip 10.mp4",
                "a/one.mp4",
                "a/2/x.mp4",
                "b/Replay.mp4"
            ]
        );
        assert_eq!(found.folders.len(), 1);
        assert!(!found.truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leaves_files_and_missing_paths_out_of_the_folders() {
        let root = scratch("kinds");
        touch(&root.join("Replays/one.mp4"));
        touch(&root.join("loose.mp4"));
        let replays = root.join("Replays").to_string_lossy().into_owned();
        let found = folder_videos(
            &[
                root.join("loose.mp4").to_string_lossy().into_owned(),
                replays.clone(),
                root.join("gone").to_string_lossy().into_owned(),
            ],
            VIDEO,
        );
        assert_eq!(found.folders, [replays]);
        assert_eq!(names(&root, &found.videos), ["Replays/one.mp4"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stops_at_the_video_limit() {
        let root = scratch("limit");
        for index in 0..MAX_VIDEOS + 3 {
            touch(&root.join(format!("{index}.mp4")));
        }
        let found = folder_videos(&[root.to_string_lossy().into_owned()], VIDEO);
        assert_eq!(found.videos.len(), MAX_VIDEOS);
        assert!(found.truncated);
        assert!(found.videos[0].ends_with("0.mp4"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_a_link_back_to_a_parent() {
        let root = scratch("loop");
        touch(&root.join("inside/one.mp4"));
        std::os::unix::fs::symlink(&root, root.join("inside/back")).unwrap();
        let found = folder_videos(&[root.to_string_lossy().into_owned()], VIDEO);
        assert_eq!(names(&root, &found.videos), ["inside/one.mp4"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn natural_order_compares_numbers_by_value() {
        let mut list = vec!["Clip 10", "clip 9", "Clip 1", "Clip 01", "Apple"];
        list.sort_by(|a, b| natural_order(a, b));
        assert_eq!(list, ["Apple", "Clip 01", "Clip 1", "clip 9", "Clip 10"]);
    }
}
