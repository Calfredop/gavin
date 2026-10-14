//! `gavin-mcp shell-writes pre|post`: the hook a Claude Code or kimi
//! launch runs around every shell call (`protocol::shell_writes`).
//!
//! `pre` lists the checkout's dirty files -- `git status`, untracked files
//! one by one -- with each one's modification time and size, and leaves
//! that snapshot on disk under the call's ids. `post` lists them again
//! and records with the daemon every path that is dirty now and was not
//! before, or was and has changed on disk since: what the call wrote.
//! Index-only changes are not writes, so a `git add` of somebody else's
//! file credits the call with nothing; a file the call deleted is dirty
//! with no stamp, which differs from the stamp it had.
//!
//! What it cannot tell apart: anything else that writes in the same
//! checkout while the call runs -- another agent sharing it, the human, a
//! watcher -- lands in the same window and is credited to this call too.
//! The window opens when the CLI proposes the command, before any
//! permission prompt, so a command that waited on the human has a longer
//! one. A background command (`run_in_background`) has its window closed
//! the moment it is started, so what it writes later is not its own --
//! it lands in whichever call of the run is watching then.
//!
//! Observation only, every failure silent: the CLI's stdin is always
//! read to the end, nothing is printed, and the process exits 0 whatever
//! happened (`main`). A command that plainly writes nothing (`may_write`)
//! takes no snapshot and is never recorded, so the transcript's own
//! reading -- which judges it unwriting by the same table -- stands for it.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use protocol::shell_writes::{may_write, POST, PRE};
use protocol::Request;

use crate::DaemonTransport;

/// How much of the CLI's JSON is kept. Far above any payload: a
/// PostToolUse carries the command's output, which the CLI truncates
/// long before this. Whatever is beyond it is still read and dropped.
const MAX_INPUT_BYTES: u64 = 8 * 1024 * 1024;

/// The largest record sent. A call that changed so many files its record
/// would near the daemon's line cap (`MAX_LINE_BYTES`) is not recorded at
/// all: the transcript's reading stands for it rather than a list the
/// daemon would drop on the floor.
const MAX_RECORD_BYTES: usize = 512 * 1024;

/// A snapshot older than this belongs to a call whose `post` never came
/// -- refused at a permission prompt, interrupted, a CLI that died -- and
/// is swept by the next `pre`.
const SNAPSHOT_KEPT: Duration = Duration::from_secs(24 * 60 * 60);

/// What a CLI hands its hook, as far as this reads it. Claude Code and
/// kimi send the same facts under the same names, but for the call's id:
/// Claude Code's `tool_use_id`, kimi's `tool_call_id`.
#[derive(Debug, PartialEq)]
pub struct Call {
    pub conversation_id: String,
    pub tool_call_id: String,
    pub command: String,
    pub cwd: PathBuf,
}

pub fn parse_call(input: &[u8]) -> Option<Call> {
    let doc: serde_json::Value = serde_json::from_slice(input).ok()?;
    let text = |key: &str| doc.get(key).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
    Some(Call {
        conversation_id: text("session_id")?.to_string(),
        tool_call_id: text("tool_use_id").or_else(|| text("tool_call_id"))?.to_string(),
        command: doc.pointer("/tool_input/command").and_then(|v| v.as_str())?.to_string(),
        cwd: PathBuf::from(text("cwd")?),
    })
}

/// A dirty file's modification time and size; `None` for one that is
/// dirty because it is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Stamp {
    secs: i64,
    nanos: u32,
    len: u64,
}

/// The checkout's dirty files, root-relative, each with its stamp.
pub type Dirty = BTreeMap<String, Option<Stamp>>;

#[derive(serde::Serialize, serde::Deserialize)]
struct Snapshot {
    root: String,
    dirty: Dirty,
}

/// Where snapshots wait for their `post`: the app's own data directory,
/// which is the user's alone -- unlike a shared `/tmp`.
pub fn snapshot_dir() -> Option<PathBuf> {
    protocol::app_support_dir().ok().map(|dir| dir.join("shell-writes"))
}

/// Reads the CLI's JSON to the end, keeping at most `MAX_INPUT_BYTES`.
fn read_input(input: &mut dyn Read) -> Vec<u8> {
    let mut kept = Vec::new();
    let _ = (&mut *input).take(MAX_INPUT_BYTES).read_to_end(&mut kept);
    drain(input);
    kept
}

/// Reads whatever is left of `input` and drops it: a CLI writing a
/// payload larger than the pipe must never be left blocked on a hook
/// that stopped reading.
pub fn drain(input: &mut dyn Read) {
    let _ = std::io::copy(input, &mut std::io::sink());
}

/// The hook, whole. Never fails and never prints.
pub fn run(phase: &str, input: &mut dyn Read, dir: &Path, transport: &mut dyn DaemonTransport) {
    let input = read_input(input);
    let Some(call) = parse_call(&input) else { return };
    match phase {
        PRE => {
            let _ = before(&call, dir);
        }
        POST => {
            let _ = after(&call, dir, transport);
        }
        _ => {}
    }
}

fn before(call: &Call, dir: &Path) -> Option<()> {
    if !may_write(&call.command) {
        return None;
    }
    let root = repo_root(&call.cwd)?;
    let dirty = dirty(&root)?;
    std::fs::create_dir_all(dir).ok()?;
    sweep(dir);
    let snapshot = Snapshot { root: root.to_str()?.to_string(), dirty };
    std::fs::write(dir.join(snapshot_name(call)?), serde_json::to_vec(&snapshot).ok()?).ok()
}

fn after(call: &Call, dir: &Path, transport: &mut dyn DaemonTransport) -> Option<()> {
    let file = dir.join(snapshot_name(call)?);
    let text = std::fs::read(&file).ok()?;
    let _ = std::fs::remove_file(&file);
    let snapshot: Snapshot = serde_json::from_slice(&text).ok()?;
    let now = dirty(Path::new(&snapshot.root))?;
    let request = Request::RecordShellWrites {
        conversation_id: call.conversation_id.clone(),
        tool_call_id: call.tool_call_id.clone(),
        root: snapshot.root,
        paths: changed(&snapshot.dirty, &now),
    };
    if serde_json::to_vec(&request).ok()?.len() > MAX_RECORD_BYTES {
        return None;
    }
    transport.request(&request).ok().map(|_| ())
}

/// The snapshot's file name: both ids, cut to characters that cannot
/// leave the directory. `None` when either cuts to nothing.
fn snapshot_name(call: &Call) -> Option<String> {
    let safe = |id: &str| -> Option<String> {
        let kept: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).collect();
        (!kept.is_empty()).then_some(kept)
    };
    Some(format!("{}.{}.json", safe(&call.conversation_id)?, safe(&call.tool_call_id)?))
}

/// Removes snapshots whose `post` never came.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|at| SystemTime::now().duration_since(at).ok())
            .is_some_and(|age| age > SNAPSHOT_KEPT);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The repository `cwd` is in: the nearest ancestor holding a `.git`, a
/// directory or a worktree's file. Walked rather than asked of git, which
/// would be a third process per call for an answer the disk already has.
pub fn repo_root(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors().find(|dir| dir.join(".git").exists()).map(Path::to_path_buf)
}

/// The checkout's dirty files with their stamps, or `None` when git
/// cannot say. `--no-optional-locks` so the scan never takes the index
/// lock an agent's own `git commit` may be about to want.
pub fn dirty(root: &Path) -> Option<Dirty> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(porcelain_paths(&out.stdout).into_iter().map(|path| (path.clone(), stamp(&root.join(&path)))).collect())
}

/// The paths in `git status --porcelain=v1 -z` output: every entry's
/// path, and for a rename or a copy the path it came from too, which
/// follows it as a field of its own.
pub fn porcelain_paths(raw: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        out.push(String::from_utf8_lossy(&entry[3..]).into_owned());
        if entry[..2].iter().any(|b| matches!(b, b'R' | b'C')) {
            if let Some(from) = fields.next() {
                out.push(String::from_utf8_lossy(from).into_owned());
            }
        }
    }
    out
}

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let (secs, nanos) = match modified.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as i64, d.subsec_nanos()),
        Err(e) => (-(e.duration().as_secs() as i64), e.duration().subsec_nanos()),
    };
    Some(Stamp { secs, nanos, len: meta.len() })
}

/// The paths dirty in `after` that were not in `before`, or were with a
/// different stamp. A path that left the dirty set is not listed: the
/// call made it clean, and a clean file is nobody's change.
pub fn changed(before: &Dirty, after: &Dirty) -> Vec<String> {
    after.iter().filter(|(path, stamp)| before.get(*path) != Some(*stamp)).map(|(path, _)| path.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Response;

    #[derive(Default)]
    struct Recorder {
        requests: Vec<Request>,
    }

    impl DaemonTransport for Recorder {
        fn request(&mut self, req: &Request) -> anyhow::Result<Response> {
            self.requests.push(req.clone());
            Ok(Response::Ok)
        }
    }

    fn git(root: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    /// A repository with four committed files, one of them already
    /// changed by somebody else before the call.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        std::fs::create_dir_all(root.join("src")).unwrap();
        for file in ["src/a.ts", "src/b.ts", "src/read.ts", "src/gone.ts", "src/neighbour.ts"] {
            std::fs::write(root.join(file), "x\n").unwrap();
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);
        std::fs::write(root.join("src/neighbour.ts"), "a co-tenant's edit\n").unwrap();
        std::fs::write(root.join("src/read.ts"), "dirty, and only read\n").unwrap();
        dir
    }

    fn payload(event: &str, cwd: &Path, command: &str) -> Vec<u8> {
        serde_json::json!({
            "session_id": "conv-1",
            "hook_event_name": event,
            "tool_name": "Bash",
            "tool_input": { "command": command },
            "tool_use_id": "toolu_1",
            "cwd": cwd,
        })
        .to_string()
        .into_bytes()
    }

    fn hook(phase: &str, input: Vec<u8>, dir: &Path, recorder: &mut Recorder) {
        run(phase, &mut std::io::Cursor::new(input), dir, recorder);
    }

    #[test]
    fn both_clis_payloads_are_read_and_anything_short_of_one_is_not() {
        let claude = br#"{"session_id":"c","tool_use_id":"toolu_1","tool_input":{"command":"ls"},"cwd":"/r"}"#;
        let kimi = br#"{"session_id":"session_c","tool_call_id":"tool_1","tool_input":{"command":"ls"},"cwd":"/r","client_type":"cli"}"#;
        assert_eq!(
            parse_call(claude),
            Some(Call { conversation_id: "c".into(), tool_call_id: "toolu_1".into(), command: "ls".into(), cwd: "/r".into() })
        );
        assert_eq!(parse_call(kimi).unwrap().tool_call_id, "tool_1");
        for broken in [
            &b"not json"[..],
            br#"{"tool_use_id":"t","tool_input":{"command":"ls"},"cwd":"/r"}"#,
            br#"{"session_id":"c","tool_input":{"command":"ls"},"cwd":"/r"}"#,
            br#"{"session_id":"c","tool_use_id":"t","tool_input":{},"cwd":"/r"}"#,
            br#"{"session_id":" ","tool_use_id":"t","tool_input":{"command":"ls"},"cwd":"/r"}"#,
        ] {
            assert_eq!(parse_call(broken), None);
        }
    }

    #[test]
    fn porcelain_entries_and_both_ends_of_a_rename_are_read() {
        let raw = b" M src/a b.ts\0?? new.ts\0R  to.ts\0from.ts\0 D gone.ts\0";
        assert_eq!(porcelain_paths(raw), ["src/a b.ts", "new.ts", "to.ts", "from.ts", "gone.ts"]);
    }

    #[test]
    fn a_path_is_changed_when_it_arrived_or_its_stamp_moved() {
        let at = |secs| Some(Stamp { secs, nanos: 0, len: 1 });
        let before: Dirty = [("kept", at(1)), ("touched", at(1)), ("cleaned", at(1)), ("deleted", at(1))]
            .into_iter()
            .map(|(p, s)| (p.to_string(), s))
            .collect();
        let after: Dirty = [("kept", at(1)), ("touched", at(2)), ("deleted", None), ("new", at(3))]
            .into_iter()
            .map(|(p, s)| (p.to_string(), s))
            .collect();
        assert_eq!(changed(&before, &after), ["deleted", "new", "touched"]);
    }

    /// The card's case: a command that writes files it never names (a
    /// formatter run as a script) is credited with exactly what it wrote
    /// -- a file it changed, one it created, one it deleted -- and not
    /// with a dirty file it only read, nor a co-tenant's change that sat
    /// still through the call.
    #[test]
    fn a_call_is_credited_with_what_it_wrote_and_nothing_it_only_read() {
        let repo = repo();
        let root = repo.path().canonicalize().unwrap();
        let snapshots = tempfile::tempdir().unwrap();
        let mut recorder = Recorder::default();
        let command = "npm run format";

        hook(PRE, payload("PreToolUse", &root.join("src"), command), snapshots.path(), &mut recorder);
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(root.join("src/a.ts"), "formatted\n").unwrap();
        std::fs::write(root.join("src/new.ts"), "generated\n").unwrap();
        std::fs::remove_file(root.join("src/gone.ts")).unwrap();
        let _ = std::fs::read(root.join("src/read.ts")).unwrap();
        hook(POST, payload("PostToolUse", &root.join("src"), command), snapshots.path(), &mut recorder);

        let [Request::RecordShellWrites { conversation_id, tool_call_id, root: recorded, paths }] =
            &recorder.requests[..]
        else {
            panic!("one record expected: {:?}", recorder.requests)
        };
        assert_eq!((conversation_id.as_str(), tool_call_id.as_str()), ("conv-1", "toolu_1"));
        assert_eq!(recorded, &root.to_string_lossy());
        assert_eq!(paths, &["src/a.ts", "src/gone.ts", "src/new.ts"]);
        assert_eq!(std::fs::read_dir(snapshots.path()).unwrap().count(), 0, "the snapshot is consumed");
    }

    #[test]
    fn rewriting_an_already_dirty_file_credits_it_and_staging_one_does_not() {
        let repo = repo();
        let root = repo.path().canonicalize().unwrap();
        let snapshots = tempfile::tempdir().unwrap();
        let mut recorder = Recorder::default();
        hook(PRE, payload("PreToolUse", &root, "./fix.sh"), snapshots.path(), &mut recorder);
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(root.join("src/read.ts"), "rewritten by the call\n").unwrap();
        git(&root, &["add", "src/neighbour.ts"]);
        hook(POST, payload("PostToolUseFailure", &root, "./fix.sh"), snapshots.path(), &mut recorder);
        let Request::RecordShellWrites { paths, .. } = &recorder.requests[0] else { panic!() };
        assert_eq!(paths, &["src/read.ts"]);
    }

    #[test]
    fn a_watched_call_that_wrote_nothing_is_recorded_as_such() {
        let repo = repo();
        let root = repo.path().canonicalize().unwrap();
        let snapshots = tempfile::tempdir().unwrap();
        let mut recorder = Recorder::default();
        hook(PRE, payload("PreToolUse", &root, "cargo test"), snapshots.path(), &mut recorder);
        hook(POST, payload("PostToolUse", &root, "cargo test"), snapshots.path(), &mut recorder);
        let Request::RecordShellWrites { paths, .. } = &recorder.requests[0] else { panic!() };
        assert!(paths.is_empty());
    }

    /// `cat` takes no snapshot, so its `post` has nothing to diff and the
    /// daemon is never asked: the run's reader judges the command by the
    /// same table and credits it with nothing either.
    #[test]
    fn a_read_only_command_is_neither_scanned_nor_recorded() {
        let repo = repo();
        let root = repo.path().canonicalize().unwrap();
        let snapshots = tempfile::tempdir().unwrap();
        let mut recorder = Recorder::default();
        hook(PRE, payload("PreToolUse", &root, "cat src/read.ts"), snapshots.path(), &mut recorder);
        assert!(!snapshots.path().join("conv-1.toolu_1.json").exists());
        hook(POST, payload("PostToolUse", &root, "cat src/read.ts"), snapshots.path(), &mut recorder);
        assert!(recorder.requests.is_empty());
    }

    #[test]
    fn outside_a_repository_or_on_a_garbled_payload_nothing_happens() {
        let plain = tempfile::tempdir().unwrap();
        let snapshots = tempfile::tempdir().unwrap();
        let mut recorder = Recorder::default();
        hook(PRE, payload("PreToolUse", plain.path(), "touch x"), snapshots.path(), &mut recorder);
        hook(POST, payload("PostToolUse", plain.path(), "touch x"), snapshots.path(), &mut recorder);
        hook(PRE, b"{".to_vec(), snapshots.path(), &mut recorder);
        hook("sideways", payload("PreToolUse", plain.path(), "touch x"), snapshots.path(), &mut recorder);
        assert!(recorder.requests.is_empty());
        assert_eq!(std::fs::read_dir(snapshots.path()).unwrap().count(), 0);
    }

    /// The CLI's pipe is read to its end however much it holds, so a
    /// payload past the cap cannot leave the CLI blocked on a full pipe.
    #[test]
    fn the_input_is_read_to_the_end_past_the_cap() {
        let big = vec![b' '; MAX_INPUT_BYTES as usize + 4096];
        let mut cursor = std::io::Cursor::new(big);
        let kept = read_input(&mut cursor);
        assert_eq!(kept.len() as u64, MAX_INPUT_BYTES);
        assert_eq!(cursor.position() as usize, cursor.get_ref().len());
    }

    #[test]
    fn an_abandoned_snapshot_is_swept_and_a_fresh_one_kept() {
        let snapshots = tempfile::tempdir().unwrap();
        let old = snapshots.path().join("c.old.json");
        let fresh = snapshots.path().join("c.fresh.json");
        std::fs::write(&old, "{}").unwrap();
        std::fs::write(&fresh, "{}").unwrap();
        let long_ago = SystemTime::now() - SNAPSHOT_KEPT - Duration::from_secs(60);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(long_ago).unwrap();
        sweep(snapshots.path());
        assert!(!old.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn a_snapshot_name_cannot_leave_its_directory() {
        let call = |conversation: &str, tool: &str| Call {
            conversation_id: conversation.into(),
            tool_call_id: tool.into(),
            command: String::new(),
            cwd: PathBuf::new(),
        };
        assert_eq!(snapshot_name(&call("../../etc", "toolu_1")).as_deref(), Some("etc.toolu_1.json"));
        assert_eq!(snapshot_name(&call("session_ab-1", "tool_X")).as_deref(), Some("session_ab-1.tool_X.json"));
        assert_eq!(snapshot_name(&call("..", "t")), None);
    }
}
