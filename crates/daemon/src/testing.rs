//! Helpers shared by more than one module's `#[cfg(test)] mod tests`.
//!
//! Compiled only under `cfg(test)`, so nothing here reaches a release
//! binary. It exists because the path-spelling rule below was needed
//! verbatim in `server::tests` and `gavin::tests` at once, and a second
//! copy of a rule is a second thing to get wrong.

use std::path::Path;

/// The separator half of the wire spelling: on Windows a reported path
/// is forward-slashed, everywhere else it is left alone.
///
/// Split out from `wire_spelling` for the paths that have no prefix to
/// resolve -- a name relative to a root, or a path whose file does not
/// exist yet -- where canonicalising is not available but the
/// separators still have to match what the daemon reports.
pub fn wire_separators(path: &str) -> String {
    if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.to_string()
    }
}

/// A path on disk in the spelling gavin puts on the wire: resolved,
/// forward slashes, and on Windows with the `\\?\` verbatim prefix
/// gone.
///
/// Spelled out here rather than handed to `protocol::wire_path`, so
/// a test comparing a REPORTED path against this is comparing two
/// independent derivations rather than the implementation with
/// itself.
///
/// Why a test needs it at all: `Path::canonicalize` on Windows
/// answers `\\?\C:\Users\x`, and nothing in gavin ever reports a
/// path in that shape -- a watcher stores
/// `protocol::canonical_path(root)` and every card id the board,
/// the orchestration store and the MCP hand around came out of that
/// scan. A test that keyed a binding on the raw canonical spelling
/// created a row nothing could ever look up, and then asserted
/// against a path the daemon does not use.
pub fn wire_spelling(path: &Path) -> String {
    let resolved = path.canonicalize().unwrap();
    let text = resolved.to_string_lossy().to_string();
    if !cfg!(windows) {
        return text;
    }
    wire_separators(text.strip_prefix(r"\\?\").unwrap_or(&text))
}
