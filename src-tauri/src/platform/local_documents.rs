use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::backend::protocol::PublicBackendError;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalDocument {
    License,
    ThirdPartyNotices,
}

fn source_notices_name() -> &'static str {
    if cfg!(target_os = "linux") {
        "THIRD_PARTY_NOTICES_LINUX.md"
    } else {
        "THIRD_PARTY_NOTICES.md"
    }
}

fn resolve_document(
    document: LocalDocument,
    resource_dir: &Path,
    source_root: Option<&Path>,
) -> Result<PathBuf, PublicBackendError> {
    let name = match document {
        LocalDocument::License => "LICENSE",
        LocalDocument::ThirdPartyNotices => "THIRD_PARTY_NOTICES.md",
    };
    let bundled = resource_dir.join(name);
    if bundled.is_file() {
        return Ok(bundled);
    }
    // only development supplies a source root; installed builds use their bundled notices
    if let Some(root) = source_root {
        let source = match document {
            LocalDocument::License => root.join("LICENSE"),
            LocalDocument::ThirdPartyNotices => root.join("packaging").join(source_notices_name()),
        };
        if source.is_file() {
            return Ok(source);
        }
    }
    Err(PublicBackendError::new(
        "DOCUMENT_UNAVAILABLE",
        "This document is missing. Reinstall Tuck to restore it.",
    ))
}

pub(crate) fn open_document_with(
    document: LocalDocument,
    resource_dir: &Path,
    source_root: Option<&Path>,
    open: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), PublicBackendError> {
    let path = resolve_document(document, resource_dir, source_root)?;
    open(&path).map_err(|_| {
        PublicBackendError::new("OPEN_FAILED", "Could not open this document. Try again.")
    })
}

pub(crate) fn open_document_file(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        // LICENSE has no extension, so open both text documents in the built-in text editor
        std::process::Command::new("notepad.exe")
            .arg(path)
            .spawn()
            .map(|_| ())
    }
    #[cfg(not(target_os = "windows"))]
    {
        use crate::platform::opener::{Opener, SystemOpener};
        SystemOpener.open(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct Documents(PathBuf);

    impl Documents {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "tuck-documents-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for Documents {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_known_documents_are_accepted() {
        assert!(serde_json::from_str::<LocalDocument>("\"license\"").is_ok());
        assert!(serde_json::from_str::<LocalDocument>("\"third_party_notices\"").is_ok());
        for value in [
            "../LICENSE",
            "file:///etc/passwd",
            "C:\\secret.txt",
            "third-party-notices",
        ] {
            assert!(serde_json::from_value::<LocalDocument>(serde_json::json!(value)).is_err());
        }
    }

    #[test]
    fn installed_documents_resolve_inside_resources() {
        let root = Documents::new();
        for (document, name) in [
            (LocalDocument::License, "LICENSE"),
            (LocalDocument::ThirdPartyNotices, "THIRD_PARTY_NOTICES.md"),
        ] {
            fs::write(root.0.join(name), "local document").unwrap();
            assert_eq!(
                resolve_document(document, &root.0, None).unwrap(),
                root.0.join(name)
            );
        }
    }

    #[test]
    fn missing_installed_documents_return_an_error_without_source_fallback() {
        let root = Documents::new();
        let error = resolve_document(LocalDocument::License, &root.0, None).unwrap_err();
        assert_eq!(error.code, "DOCUMENT_UNAVAILABLE");
        fs::create_dir(root.0.join("LICENSE")).unwrap();
        assert!(resolve_document(LocalDocument::License, &root.0, None).is_err());
    }

    #[test]
    fn opening_uses_the_resolved_document_and_reports_opener_errors() {
        let root = Documents::new();
        fs::write(root.0.join("LICENSE"), "license").unwrap();
        let result = open_document_with(LocalDocument::License, &root.0, None, |path| {
            assert_eq!(path, root.0.join("LICENSE"));
            Err(std::io::Error::other("no text viewer"))
        });
        assert_eq!(result.unwrap_err().code, "OPEN_FAILED");
        assert!(open_document_with(LocalDocument::License, &root.0, None, |_| Ok(())).is_ok());
    }

    #[test]
    fn missing_documents_never_call_the_opener() {
        let root = Documents::new();
        let result = open_document_with(LocalDocument::License, &root.0, None, |_| {
            panic!("a missing document must not be opened")
        });
        assert_eq!(result.unwrap_err().code, "DOCUMENT_UNAVAILABLE");
    }

    #[test]
    fn source_fallback_is_explicit_and_prefers_bundled_documents() {
        let resources = Documents::new();
        let source = Documents::new();
        fs::write(source.0.join("LICENSE"), "source license").unwrap();
        fs::create_dir(source.0.join("packaging")).unwrap();
        fs::write(
            source.0.join("packaging").join(source_notices_name()),
            "source notices",
        )
        .unwrap();
        assert_eq!(
            resolve_document(LocalDocument::License, &resources.0, Some(&source.0)).unwrap(),
            source.0.join("LICENSE")
        );
        assert_eq!(
            resolve_document(
                LocalDocument::ThirdPartyNotices,
                &resources.0,
                Some(&source.0)
            )
            .unwrap(),
            source.0.join("packaging").join(source_notices_name())
        );
        fs::write(resources.0.join("LICENSE"), "installed license").unwrap();
        assert_eq!(
            resolve_document(LocalDocument::License, &resources.0, Some(&source.0)).unwrap(),
            resources.0.join("LICENSE")
        );
    }
}
