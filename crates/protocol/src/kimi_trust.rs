//! kimi's folder trust: the record kimi reads before it starts a
//! project's MCP servers, and the one rule for when gavin writes it for a
//! session about to launch.
//!
//! In a folder with no record kimi stops at "Trust this folder?" -- or,
//! run headless, silently skips every project MCP server, gavin's
//! included. It keys the record on the process's exact physical cwd: a
//! trusted parent does not cover a child, and a worktree is a workspace
//! of its own (proved against kimi 2.1.1, 2026-10-06).
//!
//! Two processes launch kimi. The app does, for every launch that goes
//! through its `create_session` (board runs, rails, Best-of-N, reviews,
//! the headless commit) and for the Integration step's grant at the root.
//! The daemon does too, for an agent's `gavin_spawn_session`, which never
//! passes through the app. Both read this module, so the key, the record
//! and the launch rule are held in one place.
//!
//! Pure, like [`crate::playwright`]: the disk is reached through
//! [`TrustFiles`], which each caller implements over its own, and the
//! clock is handed in. Nothing here reads the OS, so the module needs no
//! `os` feature.

use std::path::{Path, PathBuf};

/// The folder inside a workspace that every worktree gavin cuts lands in:
/// the app's `git::commands::WORKTREES_DIR`, which a test there holds
/// equal to this one.
pub const WORKTREES_DIR: &str = ".gavin-worktrees";

/// The disk the record and the MCP files are on: the machine kimi runs
/// on, which is the only one where a record means anything.
pub trait TrustFiles {
    /// The directory's physical path, or `None` when it does not exist.
    fn canonical_dir(&self, path: &Path) -> Option<PathBuf>;
    fn is_file(&self, path: &Path) -> bool;
    /// The file's text, or `None` when there is no such file.
    fn read_to_string(&self, path: &Path) -> anyhow::Result<Option<String>>;
    /// Writes a file in the user's own kimi state, creating the parents.
    /// kimi keeps it owner-only, so an implementation over a real unix
    /// disk narrows the modes.
    fn write_private(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()>;
}

/// What a grant came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Grant {
    /// A record was written at this path.
    Written(PathBuf),
    /// The folder already has one -- the human's own answer to kimi's
    /// prompt, or an earlier run's. Left exactly as it was.
    Present,
    /// Not granted, and why, in words a report can show as they are.
    Withheld(String),
}

/// `\\?\C:\x` becomes `C:\x` and `\\?\UNC\host\share` becomes
/// `\\host\share`: the spelling `std::fs::canonicalize` gives on Windows,
/// which no process's own cwd ever has -- and the cwd is what kimi keys
/// its records on.
pub fn without_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// kimi's `canonicalWorkspaceRoot` for a path that is already absolute and
/// physical: backslashes to `/`, trailing `/` dropped, and a drive or UNC
/// shaped path lowercased (Windows paths compare case-insensitively).
fn canonical_root(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let bytes = slashed.as_bytes();
    let win_shaped = slashed.starts_with("//")
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/');
    let trimmed = slashed.trim_end_matches('/');
    let key = if win_shaped { trimmed.to_lowercase() } else { trimmed.to_string() };
    if key.is_empty() {
        slashed
    } else {
        key
    }
}

/// The directory-name part of a kimi workdir key: kimi's
/// `slugifyWorkDirName`. Lowercased, every run outside `[a-z0-9._-]`
/// collapsed to one `-`, `-` trimmed from both ends, cut to 40, trimmed
/// again, and `workspace` when nothing usable is left.
fn slug(name: &str) -> String {
    let mut slug = String::new();
    let mut in_run = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    let slug = slug.trim_matches('-');
    if matches!(slug, "" | "." | "..") {
        "workspace".to_string()
    } else {
        slug.to_string()
    }
}

/// kimi's `encodeWorkDirKey`: `wd_<slug of the last segment>_<first 12 hex
/// of sha256 of the whole normalised path>`. The hash covers the whole
/// path, so a repository and each of its worktrees are different
/// workspaces -- which is also why a trusted parent does not cover a
/// child.
///
/// Read out of the kimi binary and checked against every key kimi itself
/// wrote on the machine it was verified on (see the test); a rule this
/// exact is not something to re-derive from two samples.
pub fn workdir_key(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let normalized = slashed.trim_end_matches('/');
    let last = normalized.rsplit('/').next().unwrap_or(normalized);
    // `hash_token_hex` is named for the tokens it was written for and is
    // plain SHA-256 of the string's UTF-8 bytes, which is all this needs.
    let hash = crate::hash_token_hex(normalized);
    format!("wd_{}_{}", slug(last), &hash[..12])
}

/// The trust key for a folder: canonical first (kimi's `trustKey`), then
/// the workdir key of THAT.
pub fn trust_key(root: &str) -> String {
    workdir_key(&canonical_root(root))
}

/// The record's bytes, in kimi's own compact shape.
pub fn record(root: &str, trusted_at_ms: u128) -> String {
    serde_json::json!({ "root": root, "trustedAt": trusted_at_ms as u64 }).to_string()
}

/// kimi's home: `KIMI_CODE_HOME` when it names an absolute directory
/// (documented, and what the scratch setups in the spike use), else
/// `~/.kimi-code`. A relative value is ignored rather than guessed at --
/// kimi would resolve it against a cwd gavin does not know.
pub fn home_from(home: &Path, override_dir: Option<std::ffi::OsString>) -> PathBuf {
    match override_dir.map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => dir,
        _ => home.join(".kimi-code"),
    }
}

/// Where kimi looks for the record of `physical`, under `kimi_home`.
pub fn record_path(kimi_home: &Path, physical: &str) -> PathBuf {
    kimi_home.join("workspace-trust").join(trust_key(physical))
}

/// Writes `dir`'s record unless one is there. Never over an existing
/// record: it is the human's own answer, or an earlier run's, and either
/// way not this one's to rewrite. Keyed on the PHYSICAL path, which is
/// what kimi sees as its cwd.
pub fn write_record(
    fs: &dyn TrustFiles,
    kimi_home: &Path,
    dir: &Path,
    trusted_at_ms: u128,
) -> anyhow::Result<Grant> {
    let physical =
        without_verbatim_prefix(&fs.canonical_dir(dir).unwrap_or_else(|| dir.to_path_buf()).to_string_lossy());
    let path = record_path(kimi_home, &physical);
    if fs.is_file(&path) {
        return Ok(Grant::Present);
    }
    fs.write_private(&path, record(&physical, trusted_at_ms).as_bytes())?;
    Ok(Grant::Written(path))
}

/// One entry of a project MCP file, as much of it as the rule reads.
struct Server {
    name: String,
    command: String,
    args: Vec<String>,
}

/// What a project MCP file declares, read the way kimi reads it: an
/// absent file, an empty one and a document with no `mcpServers` all
/// declare nothing. `None` when it cannot be read or is not JSON -- what
/// trusting would start is then unknown.
fn declared(fs: &dyn TrustFiles, file: &Path) -> Option<Vec<Server>> {
    let Some(text) = fs.read_to_string(file).ok()? else {
        return Some(Vec::new());
    };
    if text.trim().is_empty() {
        return Some(Vec::new());
    }
    let doc = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let Some(servers) = doc.get("mcpServers").and_then(|s| s.as_object()) else {
        return Some(Vec::new());
    };
    Some(
        servers
            .iter()
            .map(|(name, entry)| Server {
                name: name.clone(),
                command: entry.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                args: entry
                    .get("args")
                    .and_then(|a| a.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default(),
            })
            .collect(),
    )
}

/// Whether `dir` holds either project MCP file kimi gates behind the
/// record.
fn declares_anything(fs: &dyn TrustFiles, dir: &Path) -> bool {
    fs.is_file(&dir.join(".mcp.json")) || fs.is_file(&dir.join(".kimi-code").join("mcp.json"))
}

/// Whether `dir`'s own project MCP files say only what gavin writes:
/// `.kimi-code/mcp.json` nothing at all, and `.mcp.json` nothing beyond
/// gavin's `gavin` entry and the Playwright step's, exactly as gavin
/// writes that one (`own_command` with `playwright` as its one argument).
/// With `own_command` unknown, only the `gavin` key counts as gavin's.
fn declares_only_gavins(fs: &dyn TrustFiles, dir: &Path, own_command: Option<&str>) -> bool {
    let gavins = |s: &Server| {
        s.name == "gavin"
            || own_command.is_some_and(|c| {
                s.name == crate::playwright::SUBCOMMAND && s.command == c && s.args == [crate::playwright::SUBCOMMAND]
            })
    };
    declared(fs, &dir.join(".kimi-code").join("mcp.json")).is_some_and(|servers| servers.is_empty())
        && declared(fs, &dir.join(".mcp.json")).is_some_and(|servers| servers.iter().all(gavins))
}

/// The gavin worktree a physical `cwd` runs in: `<root>/.gavin-worktrees/
/// <name>`, when that folder is a linked git checkout (its `.git` is a
/// file). Both paths are physical.
fn worktree_of(fs: &dyn TrustFiles, cwd: &Path, root: &Path) -> Option<PathBuf> {
    let mut parts = cwd.strip_prefix(root).ok()?.components();
    if parts.next()?.as_os_str() != WORKTREES_DIR {
        return None;
    }
    let worktree = root.join(WORKTREES_DIR).join(parts.next()?.as_os_str());
    fs.is_file(&worktree.join(".git")).then_some(worktree)
}

/// Grants kimi's trust record for a session LAUNCH about to run in `cwd`,
/// when `cwd` sits strictly inside a gavin workspace whose project MCP
/// configuration says only what gavin writes.
///
/// Why launches need their own grant: cards launch in context folders
/// below the workspace root, rails and Best-of-N in worktrees under
/// `.gavin-worktrees`, and none of those is covered by the root's record.
/// Such a launch used to stop at the trust screen before any MCP server
/// started, so the daemon's queued card prompt, pasted into a screen that
/// was not the chat input, was lost and the run "never started"
/// (bug-kimi-launch-folder-trust); a headless one ran without gavin's
/// tools.
///
/// What keeps this from being a blank cheque, given the record starts
/// every project MCP target kimi discovers from `cwd`:
///
/// - `cwd` must be STRICTLY INSIDE the workspace root. The root's own
///   record is the Integration step's grant (or the human's own answer at
///   kimi's prompt), and a launch never revisits that decision.
/// - No `.mcp.json` or `.kimi-code/mcp.json` may sit in any directory
///   from `cwd` up to (excluding) the root: a file there declares servers
///   nobody vetted. The one exception is a gavin worktree's own root
///   (decision A, feat-kimi-integration, 2026-10-06). A worktree is a git
///   work tree of its own, so kimi reads `.mcp.json` THERE -- in a repo
///   that commits one, every worktree has it -- and refusing on it would
///   leave every kimi run in a worktree at the trust screen. Its files
///   are vetted instead, by the same rule as the root's.
/// - The root's own files must say only what gavin writes
///   (`declares_only_gavins`). A later-added foreign server turns the
///   grant off, not on, and an unreadable file withholds.
/// - Never over an existing record (`write_record`).
///
/// The caller holds the rest of the consent rules: it passes the kimi
/// home of the machine kimi runs on (following `KIMI_CODE_HOME`, see
/// `home_from`), so a desk never writes for an ssh workspace whose home
/// is the host's.
///
/// `None` means "no grant", by shape or by policy -- not an error: kimi
/// asks once at its trust screen, as it did before this existed.
pub fn launch_grant(
    fs: &dyn TrustFiles,
    kimi_home: &Path,
    cwd: &Path,
    workspace_root: &Path,
    own_command: Option<&str>,
    trusted_at_ms: u128,
) -> Option<Grant> {
    let cwd = fs.canonical_dir(cwd)?;
    let root = fs.canonical_dir(workspace_root)?;
    if cwd == root || !cwd.starts_with(&root) {
        return None;
    }
    let worktree = worktree_of(fs, &cwd, &root);
    let mut dir = cwd.as_path();
    while dir != root {
        if Some(dir) != worktree.as_deref() && declares_anything(fs, dir) {
            return None;
        }
        dir = dir.parent()?;
    }
    if let Some(worktree) = &worktree {
        if !declares_only_gavins(fs, worktree, own_command) {
            return None;
        }
    }
    if !declares_only_gavins(fs, &root, own_command) {
        return None;
    }
    Some(
        write_record(fs, kimi_home, &cwd, trusted_at_ms)
            .unwrap_or_else(|e| Grant::Withheld(format!("could not write the trust record ({e})"))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet};

    /// A disk of absolute paths: directories that exist (their own
    /// physical paths) and files with their text.
    #[derive(Default)]
    struct Disk {
        dirs: BTreeSet<PathBuf>,
        files: RefCell<BTreeMap<PathBuf, String>>,
    }

    impl Disk {
        fn dir(mut self, path: &str) -> Self {
            self.dirs.insert(PathBuf::from(path));
            self
        }
        fn file(self, path: &str, text: &str) -> Self {
            self.files.borrow_mut().insert(PathBuf::from(path), text.to_string());
            self
        }
        fn records(&self) -> Vec<PathBuf> {
            self.files.borrow().keys().filter(|p| p.starts_with("/home/ada/.kimi-code")).cloned().collect()
        }
    }

    impl TrustFiles for Disk {
        fn canonical_dir(&self, path: &Path) -> Option<PathBuf> {
            self.dirs.contains(path).then(|| path.to_path_buf())
        }
        fn is_file(&self, path: &Path) -> bool {
            self.files.borrow().contains_key(path)
        }
        fn read_to_string(&self, path: &Path) -> anyhow::Result<Option<String>> {
            Ok(self.files.borrow().get(path).cloned())
        }
        fn write_private(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()> {
            self.files.borrow_mut().insert(path.to_path_buf(), String::from_utf8(contents.to_vec())?);
            Ok(())
        }
    }

    const GAVIN_ONLY: &str = r#"{"mcpServers":{"gavin":{"command":"scripts/gavin-mcp","args":[]}}}"#;
    const FOREIGN: &str = r#"{"mcpServers":{"gavin":{"command":"scripts/gavin-mcp"},"other":{"command":"/bin/other"}}}"#;
    const WT: &str = "/work/repo/.gavin-worktrees/feat-x";

    fn grant(disk: &Disk, cwd: &str) -> Option<Grant> {
        launch_grant(disk, Path::new("/home/ada/.kimi-code"), Path::new(cwd), Path::new("/work/repo"), None, 7)
    }

    /// A repo that commits gavin's `.mcp.json`, and one worktree of it.
    fn repo_with_worktree(worktree_mcp: &str) -> Disk {
        Disk::default()
            .dir("/work/repo")
            .dir("/work/repo/.gavin-worktrees")
            .dir(WT)
            .dir("/work/repo/.gavin-worktrees/feat-x/src")
            .file("/work/repo/.mcp.json", GAVIN_ONLY)
            .file("/work/repo/.gavin-worktrees/feat-x/.git", "gitdir: /work/repo/.git/worktrees/feat-x\n")
            .file("/work/repo/.gavin-worktrees/feat-x/.mcp.json", worktree_mcp)
    }

    /// The first three rows are keys kimi 2.1.1 wrote itself, on the
    /// machine it was verified on -- the reproduction that mattered is
    /// that they come out byte for byte. (The same check also passed for
    /// two more, longer-path entries, and for a key gavin computed that a
    /// live `kimi -p` then honoured; those paths name a person and a
    /// session, so they are not carried here.) The Windows rows come from
    /// kimi's source (`workspaceRootKey`), not from a Windows run -- K16.
    #[test]
    fn trust_keys_match_the_ones_kimi_wrote() {
        for (root, key) in [
            ("/private/tmp", "wd_tmp_11fe14a563f7"),
            ("/private/tmp/kimi-spike", "wd_kimi-spike_7f16626aeb0a"),
            ("/private/tmp/kimi-spike2", "wd_kimi-spike2_d612afd43a8e"),
            // A trailing separator is not part of the identity.
            ("/private/tmp/kimi-spike/", "wd_kimi-spike_7f16626aeb0a"),
            // A drive path is lowercased and slashed before it is hashed,
            // and `std::fs::canonicalize`'s verbatim spelling is stripped.
            (r"C:\Users\Ada\Repo\", "wd_repo_dbf5f7ee08cf"),
            (r"\\?\C:\Users\Ada\Repo", "wd_repo_dbf5f7ee08cf"),
            (r"\\?\UNC\Server\Share\Proj", "wd_proj_49ea924784e1"),
        ] {
            assert_eq!(trust_key(&without_verbatim_prefix(root)), key, "{root}");
        }
        // Trust does not inherit: a trusted parent left its child's warning
        // standing when run against kimi 2.1.1 (2026-10-06). A worktree is
        // its own workspace, so it gets its own key and needs its own record.
        assert_ne!(trust_key("/work/repo"), trust_key(WT));
    }

    #[test]
    fn slugs_follow_kimis_rule() {
        let long = "x".repeat(60);
        let dashed = format!("ab{}cd", "-".repeat(50));
        let cut_on_a_dash = format!("{} b", "a".repeat(39));
        for (name, want) in [
            ("My Project (v2)", "my-project-v2"),
            ("UPPER_case.Name", "upper_case.name"),
            ("a é b", "a-b"),
            ("Çafé-ñ", "af"),
            // Nothing usable left: kimi's own fallback.
            ("..", "workspace"),
            (".", "workspace"),
            ("", "workspace"),
            ("---", "workspace"),
            ("é", "workspace"),
            // Cut at 40, then trimmed again -- so a cut that lands on a
            // dash does not leave one behind.
            (long.as_str(), &"x".repeat(40)),
            (dashed.as_str(), "ab"),
            (cut_on_a_dash.as_str(), &"a".repeat(39)),
        ] {
            assert_eq!(slug(name), want, "{name:?}");
        }
    }

    /// Byte for byte what kimi 2.1.1 wrote for `/private/tmp/kimi-spike`.
    #[test]
    fn a_record_has_kimis_own_shape() {
        assert_eq!(
            record("/private/tmp/kimi-spike", 1791219481952),
            r#"{"root":"/private/tmp/kimi-spike","trustedAt":1791219481952}"#
        );
    }

    #[test]
    fn the_home_takes_an_absolute_override_and_nothing_else() {
        let home = Path::new("home").join("ada");
        let default = home.join(".kimi-code");
        let scratch = std::env::temp_dir().join("kimi-scratch");
        assert_eq!(home_from(&home, None), default);
        assert_eq!(home_from(&home, Some(scratch.clone().into_os_string())), scratch);
        // Relative, or blank: kimi would resolve it against a cwd gavin
        // does not know, so it is not guessed at.
        assert_eq!(home_from(&home, Some("relative/kimi".into())), default);
        assert_eq!(home_from(&home, Some("".into())), default);
    }

    /// Decision A: a rail or Best-of-N run in a worktree of a repo that
    /// commits gavin's `.mcp.json` is granted -- the worktree's own copy is
    /// vetted like the root's rather than refused on sight -- and so is a
    /// folder below the worktree's root. Each gets its own record.
    #[test]
    fn a_worktree_with_a_gavin_only_mcp_file_is_granted() {
        for cwd in [WT, "/work/repo/.gavin-worktrees/feat-x/src"] {
            let disk = repo_with_worktree(GAVIN_ONLY);

            let got = grant(&disk, cwd);

            let want = record_path(Path::new("/home/ada/.kimi-code"), cwd);
            assert_eq!(got, Some(Grant::Written(want.clone())), "{cwd}");
            assert_eq!(disk.records(), vec![want.clone()], "{cwd}: the root got no record");
            let body = disk.files.borrow().get(&want).cloned().unwrap();
            assert_eq!(body, record(cwd, 7));
            // The next launch reads the record and leaves it alone.
            assert_eq!(grant(&disk, cwd), Some(Grant::Present), "{cwd}");
        }
    }

    /// The worktree's file is vetted, not waved through: a branch that
    /// adds a foreign server, an unreadable file, or a declaring
    /// `.kimi-code/mcp.json` at the worktree root all withhold.
    #[test]
    fn a_worktree_that_declares_a_foreign_server_is_withheld() {
        for (label, disk) in [
            ("foreign .mcp.json", repo_with_worktree(FOREIGN)),
            ("unreadable .mcp.json", repo_with_worktree("{not json")),
            (
                "declaring .kimi-code/mcp.json",
                repo_with_worktree(GAVIN_ONLY)
                    .file("/work/repo/.gavin-worktrees/feat-x/.kimi-code/mcp.json", FOREIGN),
            ),
            // The root still has to say what was vetted, worktree or not.
            ("foreign root", repo_with_worktree(GAVIN_ONLY).file("/work/repo/.mcp.json", FOREIGN)),
        ] {
            assert_eq!(grant(&disk, WT), None, "{label}");
            assert!(disk.records().is_empty(), "{label}");
        }
    }

    /// The exception is the worktree's own root and nothing else: a file
    /// in a folder between the cwd and that root, or between a plain
    /// subfolder and the workspace root, still withholds -- and a folder
    /// under `.gavin-worktrees` that is no git checkout is a plain
    /// subfolder.
    #[test]
    fn an_intermediate_mcp_file_still_withholds() {
        let below_worktree = repo_with_worktree(GAVIN_ONLY)
            .file("/work/repo/.gavin-worktrees/feat-x/src/.mcp.json", GAVIN_ONLY);
        assert_eq!(grant(&below_worktree, "/work/repo/.gavin-worktrees/feat-x/src"), None);

        let plain = Disk::default()
            .dir("/work/repo")
            .dir("/work/repo/packages")
            .dir("/work/repo/packages/app")
            .file("/work/repo/.mcp.json", GAVIN_ONLY)
            .file("/work/repo/packages/.mcp.json", GAVIN_ONLY);
        assert_eq!(grant(&plain, "/work/repo/packages/app"), None);
        assert_eq!(grant(&plain, "/work/repo/packages"), None);

        let not_a_checkout = Disk::default()
            .dir("/work/repo")
            .dir("/work/repo/.gavin-worktrees")
            .dir(WT)
            .file("/work/repo/.mcp.json", GAVIN_ONLY)
            .file("/work/repo/.gavin-worktrees/feat-x/.mcp.json", GAVIN_ONLY);
        assert_eq!(grant(&not_a_checkout, WT), None);
        assert!(not_a_checkout.records().is_empty());
    }

    /// The shape rules: never at the root itself, never outside it.
    #[test]
    fn the_root_and_folders_outside_it_get_nothing() {
        let disk = repo_with_worktree(GAVIN_ONLY).dir("/work/elsewhere");
        assert_eq!(grant(&disk, "/work/repo"), None);
        assert_eq!(grant(&disk, "/work/elsewhere"), None);
        assert!(disk.records().is_empty());
    }

    /// The Playwright step's entry beside gavin's is still gavin's, in a
    /// worktree as at the root -- but only as gavin writes it, and only
    /// when the caller knows gavin's own command.
    #[test]
    fn the_playwright_entry_counts_as_gavins_only_when_known() {
        let body = r#"{"mcpServers":{"gavin":{"command":"/apps/gavin-mcp"},
                       "playwright":{"command":"/apps/gavin-mcp","args":["playwright"]}}}"#;
        for (own, granted) in [(Some("/apps/gavin-mcp"), true), (None, false), (Some("/bin/other"), false)] {
            let disk = repo_with_worktree(body).file("/work/repo/.mcp.json", body);
            let got = launch_grant(&disk, Path::new("/home/ada/.kimi-code"), Path::new(WT), Path::new("/work/repo"), own, 7);
            assert_eq!(got.is_some(), granted, "{own:?}: {got:?}");
        }
    }
}
