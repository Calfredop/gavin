//! Reading back the model list an agent ACTUALLY offers, for the CLIs
//! whose names are dated ids rather than aliases.
//!
//! The profile table's `models` is a constant compiled into gavin. That
//! is the right answer for Claude Code and Gemini, which promise that
//! `sonnet` and `pro` keep pointing at the latest model of their tier --
//! a name written once stays correct. It is the wrong answer for Codex,
//! whose picker is a list of dated slugs, and for opencode, whose
//! catalogue is assembled per machine from whichever providers that user
//! configured. Shipping a copy of either would ship something stale on
//! the day it lands.
//!
//! So those two are read at runtime, once per app start, and merged
//! BEHIND the static list rather than over it (`mergeDiscoveredModels`,
//! agentModel.ts). Which route each profile has is the table's answer
//! (`agent_setup::ModelCatalog`); this module only carries the routes
//! out.
//!
//! Three constraints shape it.
//!
//! **Failure is silent and total.** Every route returns "nothing" for a
//! missing agent, an unwritten file, a changed shape or a hung process,
//! and "nothing" leaves precisely the picker gavin had before this
//! existed. A model name is argv: an invented one is worse than none.
//!
//! **Once per PROCESS, not per call.** The frontend re-runs bootstrap on
//! every reload and on every Vite HMR remount, and spawning `opencode
//! models` each time would make a hot reload cost a subprocess. The memo
//! below is keyed on nothing and never invalidated, which is exactly what
//! "updates on each startup" means: a new list needs a new app run, the
//! same as the daemon's protocol version.
//!
//! **A Finder-launched app has the stripped login PATH.** `opencode`
//! installs to `~/.opencode/bin`, which is on nobody's default PATH, so
//! the runner falls back to the well-known locations the way
//! `pull_request::gh_binary` does.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::agent_setup::{ModelCatalog, AGENT_PROFILES};

/// How long a catalogue command may take before gavin gives up on it.
/// Generous because this runs once and off the render path, but bounded
/// because a CLI that decides to prompt for a login must not hold the
/// model picker empty forever.
const TIMEOUT: Duration = Duration::from_secs(15);

/// Where opencode installs when it is not on PATH. Its own installer's
/// default, and the reason a route can work in a terminal and fail from
/// the app.
const OPENCODE_FALLBACKS: &[&str] = &[".opencode/bin/opencode", ".local/bin/opencode"];

/// The catalogue, resolved once for the life of the app process.
///
/// A `Mutex<Option<..>>` rather than a `OnceLock` of the map itself
/// because filling it runs subprocesses: two frontend bootstraps racing
/// (a reload during startup) must produce one run and one answer, not
/// two interleaved ones.
static CACHE: OnceLock<Mutex<Option<HashMap<String, Vec<String>>>>> = OnceLock::new();

/// Every profile's runtime model list, keyed by profile id. Profiles
/// with no route, and routes that answered nothing, are absent rather
/// than present-and-empty: the frontend merges what it is given and an
/// absent key is the same statement as an empty one, so there is no
/// reason to make it say it twice.
#[tauri::command]
pub fn agent_model_catalog() -> HashMap<String, Vec<String>> {
    let cell = CACHE.get_or_init(|| Mutex::new(None));
    let mut slot = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = slot.as_ref() {
        return cached.clone();
    }
    let resolved = resolve_all();
    *slot = Some(resolved.clone());
    resolved
}

fn resolve_all() -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    for profile in AGENT_PROFILES {
        let Some(route) = profile.model_catalog else {
            continue;
        };
        let models = match route {
            ModelCatalog::CodexCache => codex_models(&codex_home()),
            ModelCatalog::OpencodeCli => opencode_models(),
        };
        if !models.is_empty() {
            out.insert(profile.id.to_string(), models);
        }
    }
    out
}

// ---- codex ------------------------------------------------------------------

/// `~/.codex`, matching `agent_usage::codex_sessions_dir` and
/// `agent_tokens`. Deliberately not honouring `CODEX_HOME`: gavin's three
/// codex readers must agree about where codex lives, and a GUI app's
/// environment is not the shell's anyway, so reading the variable here
/// would mostly succeed at disagreeing with the other two.
fn codex_home() -> PathBuf {
    home_dir().unwrap_or_default().join(".codex")
}

/// Local, like agent_usage's and agent_tokens': `$HOME` is what a Tauri
/// host on macOS actually has, and one shared helper would be a
/// dependency between three modules that share nothing else.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn codex_models(home: &Path) -> Vec<String> {
    std::fs::read_to_string(home.join("models_cache.json"))
        .map(|text| parse_codex_catalog(&text))
        .unwrap_or_default()
}

/// The `slug`s codex's own picker would show, in the order its catalogue
/// lists them.
///
/// `visibility` is the filter that matters: the catalogue carries rows
/// like `codex-auto-review` and the `gpt-daybreak-*` internals marked
/// `hide`, which answer a request but are not models anyone means to
/// choose. A row with no `visibility` at all is KEPT -- an unknown shape
/// should cost a name, not the whole list -- while `hide` and `none` are
/// dropped by name.
///
/// Shared with `models.json`, the bundled catalogue `codex debug models
/// --bundled` prints: both wrap the same `models` array, so one parser
/// reads either.
pub fn parse_codex_catalog(text: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(models) = value.get("models").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for model in models {
        if matches!(model.get("visibility").and_then(|v| v.as_str()), Some("hide" | "none")) {
            continue;
        }
        let Some(slug) = model.get("slug").and_then(|s| s.as_str()) else {
            continue;
        };
        let slug = slug.trim();
        if !slug.is_empty() && !out.iter().any(|seen| seen == slug) {
            out.push(slug.to_string());
        }
    }
    out
}

// ---- opencode ---------------------------------------------------------------

fn opencode_models() -> Vec<String> {
    match run(&opencode_binary(), &["models"]) {
        Some(stdout) => parse_opencode_models(&stdout),
        None => Vec::new(),
    }
}

/// One `provider/model` per line, in the order opencode prints them --
/// which groups by provider and puts opencode's own hosted models first,
/// so a picker that keeps the order stays readable at 450 rows.
///
/// A line without a `/` is dropped rather than kept: everything opencode
/// lists is qualified, so an unqualified line is a banner, a warning or a
/// prompt, and `--model <that>` is the error this module exists to avoid.
pub fn parse_opencode_models(stdout: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || !line.contains('/') || line.contains(char::is_whitespace) {
            continue;
        }
        if !out.iter().any(|seen| seen == line) {
            out.push(line.to_string());
        }
    }
    out
}

// ---- running one -----------------------------------------------------------

/// The opencode to run: the one on PATH if there is one, else the first
/// well-known install that exists. Resolved per call for the same reason
/// `gh_binary` is -- and, unlike gh, this one is genuinely likely to be
/// off PATH, because its installer writes to `~/.opencode/bin`.
fn opencode_binary() -> String {
    if on_path("opencode") {
        return "opencode".to_string();
    }
    let home = home_dir().unwrap_or_default();
    for suffix in OPENCODE_FALLBACKS {
        let candidate = home.join(suffix);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "opencode".to_string()
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

/// One catalogue command, run to the deadline. `None` for anything that
/// is not a clean exit with output: an absent binary, a non-zero status,
/// a timeout. The caller turns that into "no route", which is the same
/// answer as having none.
///
/// stdout is drained on a thread, the deadlock avoidance git/run.rs
/// documents: a child that fills the pipe buffer blocks forever if the
/// parent waits before reading, and 450 lines is not a small pipe.
fn run(bin: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(bin)
        .args(args)
        // The temp dir, not a workspace: the profile table is app-wide,
        // so the answer must be the machine's catalogue rather than
        // whatever a project-scoped `opencode.json` happens to narrow it
        // to. It also keeps the run reproducible -- a GUI app's cwd is
        // whatever it was launched with.
        .current_dir(std::env::temp_dir())
        // Nothing here is interactive, and a CLI that decides to ask for
        // a login anyway must hit EOF rather than hold the deadline.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // A catalogue parsed line by line must not arrive wearing escape
        // sequences because the CLI thought a human was reading.
        .env("NO_COLOR", "1")
        .spawn()
        .ok()?;
    let mut pipe = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    rx.recv_timeout(Duration::from_secs(2)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real slice of codex's catalogue, field for field: the wrapper
    /// `models_cache.json` adds around the array, `visibility` on every
    /// row, and one `hide` row of the kind codex ships for its own
    /// internal use.
    const CODEX_CACHE: &str = r#"{
      "fetched_at": "2026-09-06T10:00:00Z",
      "etag": "W/\"abc\"",
      "client_version": "1.2.3",
      "models": [
        { "slug": "gpt-6-astra", "display_name": "GPT-6-Astra", "visibility": "list" },
        { "slug": "gpt-5.6-sol", "display_name": "GPT-5.6-Sol", "visibility": "list" },
        { "slug": "gpt-daybreak-blue-latest", "display_name": "Daybreak Blue", "visibility": "hide" },
        { "slug": "codex-auto-review", "display_name": "Codex Auto Review", "visibility": "none" }
      ]
    }"#;

    #[test]
    fn codex_catalogue_keeps_the_listed_slugs_in_order() {
        assert_eq!(parse_codex_catalog(CODEX_CACHE), vec!["gpt-6-astra", "gpt-5.6-sol"]);
    }

    /// The whole point of the module: a shape gavin does not recognise
    /// must cost the LIST, never produce a name. Every one of these would
    /// otherwise reach somebody's argv.
    #[test]
    fn codex_catalogue_answers_nothing_for_anything_unexpected() {
        assert!(parse_codex_catalog("").is_empty());
        assert!(parse_codex_catalog("not json at all").is_empty());
        assert!(parse_codex_catalog(r#"{"models": "a string"}"#).is_empty());
        assert!(parse_codex_catalog(r#"{"data": [{"slug": "x"}]}"#).is_empty());
        assert!(parse_codex_catalog(r#"{"models": [{"display_name": "no slug"}]}"#).is_empty());
    }

    /// An unknown shape should cost a name, not the list: a row with no
    /// `visibility` is a row codex's own picker would show under a
    /// schema gavin has not seen, and dropping it silently would shrink
    /// the picker for no stated reason.
    #[test]
    fn codex_rows_with_no_visibility_are_kept() {
        assert_eq!(parse_codex_catalog(r#"{"models":[{"slug":"gpt-x"}]}"#), vec!["gpt-x"]);
    }

    #[test]
    fn a_missing_codex_home_is_an_empty_list_not_a_panic() {
        let missing = std::env::temp_dir().join("gavin-no-such-codex-home");
        assert!(codex_models(&missing).is_empty());
    }

    /// Measured against opencode 1.3.13: `opencode models` prints one
    /// bare `provider/model` per line and nothing else.
    #[test]
    fn opencode_lines_are_taken_as_provider_slash_model() {
        let out = "opencode/big-pickle\ngoogle/gemini-2.5-flash\nanthropic/claude-opus-5\n";
        assert_eq!(
            parse_opencode_models(out),
            vec!["opencode/big-pickle", "google/gemini-2.5-flash", "anthropic/claude-opus-5"]
        );
    }

    /// Anything that is not a bare qualified name is a banner, a warning
    /// or a prompt -- and `--model <banner>` is the failure this module
    /// exists to avoid.
    #[test]
    fn opencode_output_that_is_not_a_model_name_is_dropped() {
        let out = "\nWarning: no providers configured\nsonnet\nfoo/bar baz\ngoogle/gemini-2.5-pro\n";
        assert_eq!(parse_opencode_models(out), vec!["google/gemini-2.5-pro"]);
    }

    #[test]
    fn opencode_repeats_are_listed_once() {
        assert_eq!(parse_opencode_models("a/b\na/b\n"), vec!["a/b"]);
    }

    /// The table drives the routes, so a row that gains or loses one
    /// must not need this module edited. Stated as a test because the
    /// opposite -- a `match` that silently misses a new variant -- is
    /// exactly how the picker would go quiet.
    #[test]
    fn every_route_in_the_table_is_one_this_module_can_run() {
        let routed: Vec<&str> = AGENT_PROFILES
            .iter()
            .filter(|p| p.model_catalog.is_some())
            .map(|p| p.id)
            .collect();
        assert_eq!(routed, vec!["codex", "opencode"]);
    }

    /// A route only makes sense where gavin can put the answer on a
    /// command line. Without a flag the picker is hidden outright, so a
    /// catalogue for such a row would be work nobody could see.
    #[test]
    fn no_profile_has_a_catalogue_it_could_not_use() {
        for profile in AGENT_PROFILES {
            assert!(
                profile.model_catalog.is_none() || !profile.model_flag.is_empty(),
                "{} has a model catalogue but no model flag",
                profile.id
            );
        }
    }
}
