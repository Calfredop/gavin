use serde::Serialize;
use std::path::PathBuf;

/// Files larger than this are truncated rather than rendered whole --
/// generous for source/markdown, small enough to never freeze the
/// renderer on a multi-GB log.
pub const MAX_VIEWER_FILE_BYTES: usize = 1024 * 1024;

/// Extensions the internal viewer handles. Everything else (images,
/// video, binaries, and any unrecognized extension) is handed to the OS's
/// default application instead -- see the design spec's Goals. Exposed to
/// the frontend via `viewable_extensions` so the cmd+click handler and
/// this list can never disagree.
pub const VIEWABLE_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "rs", "ts", "js", "tsx", "jsx", "svelte", "py", "go", "rb", "java",
    "c", "h", "cpp", "hpp", "cs", "swift", "kt", "sh", "bash", "zsh", "fish", "toml", "yaml",
    "yml", "json", "xml", "html", "css", "scss", "sql", "graphql", "lua", "php", "pl", "r",
    "dockerfile", "gitignore", "env", "ini", "conf", "cfg", "log", "csv",
];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
pub fn viewable_extensions() -> Vec<String> {
    VIEWABLE_EXTENSIONS.iter().map(|e| e.to_string()).collect()
}

/// Reads a file for display, capped at `MAX_VIEWER_FILE_BYTES`. A file
/// over the cap comes back truncated (with `truncated: true`) rather than
/// refused, so the viewer can show the beginning of a big log alongside a
/// "too large to preview in full" notice. Non-UTF8 content is an error,
/// not lossy-decoded garbage -- the frontend treats that identically to an
/// unsupported extension and offers to open externally instead.
#[tauri::command]
pub fn read_file_for_viewer(path: String) -> Result<FileContent, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let truncated = bytes.len() > MAX_VIEWER_FILE_BYTES;
    let slice = if truncated { &bytes[..MAX_VIEWER_FILE_BYTES] } else { &bytes[..] };
    let content =
        String::from_utf8(slice.to_vec()).map_err(|_| "file is not valid UTF-8 text".to_string())?;
    Ok(FileContent { content, truncated })
}

/// Resolves a path-shaped candidate string from terminal output against
/// the session's own live cwd, returning its absolute path only if it
/// actually points at a readable file. Backs the "only real paths are
/// clickable" rule -- the frontend calls this on hover and only applies
/// the clickable underline when it returns Some, so there are no
/// dead-end clicks. Directories return None: this opens files, and a
/// clickable directory that did nothing on click would be exactly the
/// dead-end this check exists to prevent.
#[tauri::command]
pub fn resolve_path_under_cursor(candidate: String, cwd: String) -> Option<String> {
    let expanded = if let Some(rest) = candidate.strip_prefix("~/") {
        let home = std::env::var("HOME").ok()?;
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(&candidate)
    };
    let absolute = if expanded.is_absolute() { expanded } else { PathBuf::from(&cwd).join(expanded) };
    let canonical = std::fs::canonicalize(&absolute).ok()?;
    if !canonical.is_file() {
        return None;
    }
    Some(canonical.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_a_small_utf8_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, "hello world").unwrap();

        let result = read_file_for_viewer(path.to_string_lossy().to_string()).unwrap();

        assert_eq!(result, FileContent { content: "hello world".to_string(), truncated: false });
    }

    #[test]
    fn truncates_a_file_larger_than_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        let mut f = std::fs::File::create(&path).unwrap();
        // 2 MiB of 'a' -- comfortably over the 1 MiB cap.
        let chunk = vec![b'a'; 1024];
        for _ in 0..2048 {
            f.write_all(&chunk).unwrap();
        }
        drop(f);

        let result = read_file_for_viewer(path.to_string_lossy().to_string()).unwrap();

        assert!(result.truncated);
        assert_eq!(result.content.len(), MAX_VIEWER_FILE_BYTES);
    }

    #[test]
    fn rejects_a_non_utf8_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("binary.bin");
        // 0xFF is never valid UTF-8.
        std::fs::write(&path, [0xFF, 0xFE, 0x00, 0x01]).unwrap();

        let result = read_file_for_viewer(path.to_string_lossy().to_string());

        assert!(result.is_err());
    }

    #[test]
    fn rejects_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.txt");

        let result = read_file_for_viewer(path.to_string_lossy().to_string());

        assert!(result.is_err());
    }

    #[test]
    fn resolves_an_absolute_path_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("real.txt");
        std::fs::write(&path, "x").unwrap();

        let resolved = resolve_path_under_cursor(
            path.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
        );

        assert!(resolved.is_some());
    }

    #[test]
    fn resolves_a_relative_path_against_the_given_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("real.txt"), "x").unwrap();

        let resolved =
            resolve_path_under_cursor("real.txt".to_string(), dir.path().to_string_lossy().to_string());

        assert!(resolved.is_some());
        assert!(resolved.unwrap().ends_with("real.txt"));
    }

    #[test]
    fn returns_none_for_a_path_that_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();

        let resolved =
            resolve_path_under_cursor("nope.txt".to_string(), dir.path().to_string_lossy().to_string());

        assert_eq!(resolved, None);
    }

    #[test]
    fn returns_none_for_a_directory_rather_than_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let subdir = dir.path().join("subdir");
        std::fs::create_dir(&subdir).unwrap();

        let resolved =
            resolve_path_under_cursor("subdir".to_string(), dir.path().to_string_lossy().to_string());

        assert_eq!(resolved, None);
    }
}
