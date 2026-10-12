//! Adopted-memory retrieval (v60, `feat-vectorized-memory.md`).
//!
//! `### Learned` in a workspace's instructions file is the durable store:
//! the human adopts a memory card in the app and the fact is appended
//! there (`app/src/lib/cards/memoryCard.ts`). This module keeps a vector
//! index DERIVED from that section, so an agent can ask
//! `gavin_search_memories` for a fact in its own words. Nothing here is
//! authoritative: the index can be deleted at any time and is rebuilt from
//! the file, and every search compares the two first and heals the index
//! when a human has edited the section by hand.
//!
//! The model is BAAI's bge-small-en-v1.5, quantized, run locally through
//! fastembed. Its weights are a one-time download into gavin's data dir,
//! made only when the human asks for it (the Memory setup step):
//! `EnsureMemoryIndex { download: false }` and a search refuse rather than
//! fetch. Queries carry BGE's retrieval instruction; passages do not --
//! that asymmetry is how the model was trained. A workspace adopts tens
//! of facts, not millions, so a search is a brute-force cosine over every
//! vector the root has.
//!
//! The grammar `parse_learned` reads is written down once, in
//! memoryCard.ts's header, and held to it on both sides by
//! `test-fixtures/learned-memories/cases.json`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use protocol::{MemoryHit, MemoryIndexStatus};

const MARKER_START: &str = "<!-- gavin:start -->";
const MARKER_END: &str = "<!-- gavin:end -->";
/// Spelled identically in memoryCard.ts and agent_setup.rs.
const LEARNED_HEADING: &str = "### Learned";

/// The files a workspace's memories can have been adopted into: the one
/// config.toml names, then every file a built-in agent profile uses. All
/// of them rather than the profile's one, because the daemon does not
/// resolve agent profiles (the app does) and a workspace that switched
/// agent keeps the facts it adopted under the old one.
const WELL_KNOWN_FILES: &[&str] = &["CLAUDE.md", "AGENTS.md", "GEMINI.md"];

/// BGE's retrieval instruction, for queries only.
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

/// Written into every index, so a later change of model empties the
/// index rather than comparing vectors from two different spaces.
const MODEL_ID: &str = "bge-small-en-v1.5-q";

/// Left in the model dir once the weights have loaded once, so "is the
/// model here" is a stat rather than a 64 MB read.
const READY_MARKER: &str = "bge-small-en-v1.5-q.ready";

const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 50;

pub const NOT_DOWNLOADED: &str = "gavin's memory model isn't on this machine yet. Run the Memory step from gavin's Home tab (or the setup wizard) to download it -- once, for every workspace.";

/// One memory, as `### Learned` holds it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct LearnedMemory {
    pub fact: String,
    pub topics: Vec<String>,
    pub why: Option<String>,
}

impl LearnedMemory {
    /// What is embedded: the fact and its reason, which is what a query
    /// in someone else's words is most likely to land near.
    fn passage(&self) -> String {
        match &self.why {
            Some(why) => format!("{} {}", self.fact, why),
            None => self.fact.clone(),
        }
    }

    /// Stable across reads, and different the moment any part of the
    /// memory is edited -- so an edited bullet is a removal plus an
    /// addition, and the index never serves a vector for text that is
    /// no longer there.
    fn id(&self) -> String {
        let text = format!("{}\n{}\n{}", self.fact, self.topics.join(","), self.why.as_deref().unwrap_or(""));
        hex(ring::digest::digest(&ring::digest::SHA256, text.as_bytes()).as_ref())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// memoryCard.ts's `normalizeTopics`, character for character.
pub fn normalize_topics(raw: &str) -> Vec<String> {
    let inner = raw.trim();
    let inner = inner.strip_prefix('[').unwrap_or(inner);
    let inner = inner.strip_suffix(']').unwrap_or(inner);
    let mut out: Vec<String> = Vec::new();
    for part in inner.split(',') {
        let cleaned: String = part.chars().filter(|c| !matches!(c, '(' | ')' | '"' | '\'')).collect();
        let t = cleaned.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// A trailing ` (topics: …)` on a bullet line: where the fact ends, and
/// the raw list. The parenthesis it opens with is the LAST one in the
/// line, since what it holds may contain none.
fn topics_suffix(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(')')?;
    let open = body.rfind('(')?;
    let inner = &body[open + 1..];
    let tag = inner.get(.."topics:".len())?;
    if inner.contains(')') || !tag.eq_ignore_ascii_case("topics:") {
        return None;
    }
    Some((open, &inner[tag.len()..]))
}

fn strip_why(line: &str) -> Option<&str> {
    let tag = line.get(..4)?;
    tag.eq_ignore_ascii_case("why:").then(|| line[4..].trim_start())
}

/// Every memory in a run of Learned text -- memoryCard.ts's
/// `parseLearned`, by the grammar in that file's header.
pub fn parse_learned(section: &str) -> Vec<LearnedMemory> {
    let mut out = Vec::new();
    let mut cur: Option<LearnedMemory> = None;
    fn flush(cur: &mut Option<LearnedMemory>, out: &mut Vec<LearnedMemory>) {
        if let Some(m) = cur.take() {
            if !m.fact.is_empty() {
                out.push(m);
            }
        }
    }
    for raw in section.split('\n') {
        let bullet = raw
            .strip_prefix('-')
            .or_else(|| raw.strip_prefix('*'))
            .filter(|rest| rest.starts_with(char::is_whitespace));
        if let Some(rest) = bullet {
            flush(&mut cur, &mut out);
            let line = rest.trim();
            let (fact, topics) = match topics_suffix(line) {
                Some((at, list)) => (line[..at].trim().to_string(), normalize_topics(list)),
                None => (line.to_string(), Vec::new()),
            };
            cur = Some(LearnedMemory { fact, topics, why: None });
        } else if let (Some(m), true) =
            (cur.as_mut(), raw.starts_with(char::is_whitespace) && !raw.trim().is_empty())
        {
            let line = raw.trim();
            match (strip_why(line), m.why.clone()) {
                (Some(why), None) => m.why = Some(why.trim().to_string()),
                (_, Some(why)) => m.why = Some(format!("{why} {line}").trim().to_string()),
                (None, None) => m.fact = format!("{} {line}", m.fact),
            }
        } else {
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// The memories one instructions file holds: its marker block's
/// `### Learned` section to the end of the block.
pub fn learned_in_file(content: &str) -> Vec<LearnedMemory> {
    let (Some(start), Some(end)) = (content.find(MARKER_START), content.find(MARKER_END)) else {
        return Vec::new();
    };
    if end < start {
        return Vec::new();
    }
    let inner = &content[start + MARKER_START.len()..end];
    let mut offset = 0usize;
    for line in inner.split_inclusive('\n') {
        offset += line.len();
        if line.trim_end() == LEARNED_HEADING {
            return parse_learned(&inner[offset..]);
        }
    }
    Vec::new()
}

/// config.toml's `[agent] file`, kept only when it is a plain relative
/// path inside the root -- this file is the human's, and its value is
/// about to be joined onto the root and read.
fn configured_file(root: &Path) -> Option<String> {
    let content = std::fs::read_to_string(root.join(".gavin-root").join("config.toml")).ok()?;
    let table = content.parse::<toml::Table>().ok()?;
    let file = table.get("agent")?.as_table()?.get("file")?.as_str()?.trim().to_string();
    let path = Path::new(&file);
    let inside = !file.is_empty()
        && path.is_relative()
        && path.components().all(|c| matches!(c, std::path::Component::Normal(_)));
    inside.then_some(file)
}

/// Every memory the workspace has adopted, once each, with the file it
/// was found in (root-relative). First file wins a memory two files hold.
pub fn read_learned(root: &Path) -> Vec<(LearnedMemory, String)> {
    let mut files: Vec<String> = configured_file(root).into_iter().collect();
    for f in WELL_KNOWN_FILES {
        if !files.iter().any(|x| x == f) {
            files.push(f.to_string());
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for file in files {
        let Ok(content) = std::fs::read_to_string(root.join(&file)) else { continue };
        for m in learned_in_file(&content) {
            if seen.insert(m.id()) {
                out.push((m, file.clone()));
            }
        }
    }
    out
}

/// Turns text into vectors. The real one is BGE through fastembed; tests
/// hand in one that needs no network and no weights.
pub trait Embedder: Send {
    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>>;
}

struct Bge(fastembed::TextEmbedding);

impl Embedder for Bge {
    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.0.embed(texts, None).map_err(|e| anyhow::anyhow!("embedding failed: {e}"))
    }
}

/// Loads the model from `model_dir`, downloading it there first when it
/// is missing.
type Loader = Box<dyn Fn(&Path) -> anyhow::Result<Box<dyn Embedder>> + Send + Sync>;

fn load_bge(model_dir: &Path) -> anyhow::Result<Box<dyn Embedder>> {
    std::fs::create_dir_all(model_dir)?;
    let options = fastembed::TextInitOptions::new(fastembed::EmbeddingModel::BGESmallENV15Q)
        .with_cache_dir(model_dir.to_path_buf())
        // It draws progress bars on stdout otherwise, which is the
        // daemon's log.
        .with_show_download_progress(false);
    let model = fastembed::TextEmbedding::try_new(options)
        .map_err(|e| anyhow::anyhow!("couldn't load the memory model: {e}"))?;
    Ok(Box::new(Bge(model)))
}

#[derive(Debug, Clone)]
enum Download {
    Idle,
    Running,
    Failed(String),
}

struct Inner {
    index_dir: PathBuf,
    model_dir: PathBuf,
    load: Loader,
    /// Loaded on first use and kept: loading is the slow part, and a
    /// daemon that searched once will search again.
    embedder: Mutex<Option<Box<dyn Embedder>>>,
    download: Mutex<Download>,
}

/// The daemon's memory indexes, one SQLite file per workspace root.
#[derive(Clone)]
pub struct Memories(Arc<Inner>);

impl Memories {
    /// Under gavin's data dir: `memory-index/` for the per-root indexes
    /// and `models/` for the weights. Shared by the release and dev
    /// daemons like kanban and orchestration are -- the index is derived,
    /// and two copies of a 64 MB model would buy nothing.
    pub fn open(data_dir: &Path) -> Self {
        Self::with_loader(data_dir.join("memory-index"), data_dir.join("models"), Box::new(load_bge))
    }

    pub fn with_loader(index_dir: PathBuf, model_dir: PathBuf, load: Loader) -> Self {
        Self(Arc::new(Inner {
            index_dir,
            model_dir,
            load,
            embedder: Mutex::new(None),
            download: Mutex::new(Download::Idle),
        }))
    }

    /// `try_lock`, because the lock is held for the whole of a download
    /// and a status read must not wait out one.
    fn model_present(&self) -> bool {
        self.0.model_dir.join(READY_MARKER).exists()
            || self.0.embedder.try_lock().map(|e| e.is_some()).unwrap_or(false)
    }

    /// Runs `f` with the loaded model, loading it first. Refuses to load
    /// one that has never been downloaded unless `download` says this is
    /// the call that is meant to fetch it.
    fn with_embedder<T>(
        &self,
        download: bool,
        f: impl FnOnce(&mut dyn Embedder) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let mut slot = self.0.embedder.lock().map_err(|_| anyhow::anyhow!("memory model lock poisoned"))?;
        if slot.is_none() {
            if !download && !self.0.model_dir.join(READY_MARKER).exists() {
                anyhow::bail!(NOT_DOWNLOADED);
            }
            let loaded = (self.0.load)(&self.0.model_dir)?;
            let _ = std::fs::create_dir_all(&self.0.model_dir);
            let _ = std::fs::write(self.0.model_dir.join(READY_MARKER), MODEL_ID);
            *slot = Some(loaded);
        }
        f(slot.as_mut().expect("loaded above").as_mut())
    }

    fn index_path(&self, root: &Path) -> PathBuf {
        let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let digest = ring::digest::digest(&ring::digest::SHA256, canonical.to_string_lossy().as_bytes());
        self.0.index_dir.join(format!("{}.sqlite", &hex(digest.as_ref())[..16]))
    }

    fn open_index(&self, root: &Path) -> anyhow::Result<rusqlite::Connection> {
        std::fs::create_dir_all(&self.0.index_dir)?;
        let conn = rusqlite::Connection::open(self.index_path(root))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS memories (
                 id TEXT PRIMARY KEY,
                 fact TEXT NOT NULL,
                 vector BLOB NOT NULL
             );",
        )?;
        // One IMMEDIATE transaction, so the check and the reset cannot
        // interleave with another connection's: a reader that saw no
        // model row and then wiped rows a sync had just written would
        // undo it -- and the dev and release daemons share these files.
        let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
        if index_model(&tx).as_deref() != Some(MODEL_ID) {
            tx.execute("DELETE FROM memories", [])?;
            tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('model', ?1)", [MODEL_ID])?;
        }
        tx.commit()?;
        Ok(conn)
    }

    /// The ids an index holds, without creating one for a root that has
    /// never had any.
    /// Writes nothing: an index from another model reads as empty, and
    /// the next sync resets it.
    fn indexed_ids(&self, root: &Path) -> HashSet<String> {
        let path = self.index_path(root);
        if !path.exists() {
            return HashSet::new();
        }
        let Ok(conn) = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            return HashSet::new();
        };
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        if index_model(&conn).as_deref() != Some(MODEL_ID) {
            return HashSet::new();
        }
        let Ok(mut stmt) = conn.prepare("SELECT id FROM memories") else { return HashSet::new() };
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Makes the index hold exactly `learned`: drops what is no longer
    /// there, embeds what is new. Embeds nothing when nothing is new, so
    /// a workspace whose model was never downloaded can still have its
    /// removals applied.
    fn sync_with(&self, root: &Path, learned: &[(LearnedMemory, String)], download: bool) -> anyhow::Result<()> {
        let want: HashMap<String, &LearnedMemory> = learned.iter().map(|(m, _)| (m.id(), m)).collect();
        let have = self.indexed_ids(root);
        let stale: Vec<&String> = have.iter().filter(|id| !want.contains_key(*id)).collect();
        let missing: Vec<(&String, &LearnedMemory)> =
            want.iter().filter(|(id, _)| !have.contains(*id)).map(|(id, m)| (id, *m)).collect();
        if stale.is_empty() && missing.is_empty() {
            return Ok(());
        }
        let vectors = if missing.is_empty() {
            Vec::new()
        } else {
            let passages: Vec<String> = missing.iter().map(|(_, m)| m.passage()).collect();
            self.with_embedder(download, |e| e.embed(&passages))?
        };
        let mut conn = self.open_index(root)?;
        let tx = conn.transaction()?;
        for id in stale {
            tx.execute("DELETE FROM memories WHERE id = ?1", [id])?;
        }
        for ((id, m), v) in missing.iter().zip(vectors) {
            tx.execute(
                "INSERT OR REPLACE INTO memories (id, fact, vector) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, m.fact, to_blob(&normalized(v))],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn model_word(&self) -> (String, Option<String>) {
        let download = self.0.download.lock().map(|d| d.clone()).unwrap_or(Download::Idle);
        match download {
            Download::Running => ("downloading".into(), None),
            _ if self.model_present() => ("ready".into(), None),
            Download::Failed(e) => ("failed".into(), Some(e)),
            Download::Idle => ("absent".into(), None),
        }
    }

    /// Where `root`'s index stands. Embeds nothing, downloads nothing.
    pub fn status(&self, root: &Path) -> MemoryIndexStatus {
        let learned = read_learned(root);
        let want: HashSet<String> = learned.iter().map(|(m, _)| m.id()).collect();
        let have = self.indexed_ids(root);
        let (model, model_error) = self.model_word();
        MemoryIndexStatus {
            model,
            model_error,
            learned: want.len() as u32,
            indexed: want.intersection(&have).count() as u32,
            in_sync: want == have,
        }
    }

    /// Brings `root`'s index up to `### Learned`. With `download`, a
    /// missing model is fetched on a thread of its own and the answer
    /// says `downloading`; without it, a missing model is an error.
    pub fn ensure(&self, root: &Path, download: bool) -> anyhow::Result<MemoryIndexStatus> {
        if self.model_present() {
            self.sync_with(root, &read_learned(root), false)?;
            return Ok(self.status(root));
        }
        if !download {
            anyhow::bail!(NOT_DOWNLOADED);
        }
        self.start_download(root.to_path_buf());
        Ok(self.status(root))
    }

    fn start_download(&self, root: PathBuf) {
        {
            let mut d = self.0.download.lock().expect("download lock");
            if matches!(*d, Download::Running) {
                return;
            }
            *d = Download::Running;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            let result = me
                .with_embedder(true, |_| Ok(()))
                .and_then(|_| me.sync_with(&root, &read_learned(&root), false));
            let mut d = me.0.download.lock().expect("download lock");
            *d = match result {
                Ok(()) => Download::Idle,
                Err(e) => {
                    eprintln!("gavin-daemon: memory model: {e:#}");
                    Download::Failed(format!("{e:#}"))
                }
            };
        });
    }

    /// The adopted memories nearest `query`, best first. Heals the index
    /// from `### Learned` before reading it.
    pub fn search(
        &self,
        root: &Path,
        query: &str,
        topics: &[String],
        limit: Option<u32>,
    ) -> anyhow::Result<Vec<MemoryHit>> {
        let query = query.trim();
        if query.is_empty() {
            anyhow::bail!("the query is empty -- say what you are looking for");
        }
        let learned = read_learned(root);
        if learned.is_empty() {
            // Nothing adopted is an answer, not a failure -- and needs no
            // model. Leftovers from a section since emptied go now.
            self.sync_with(root, &learned, false)?;
            return Ok(Vec::new());
        }
        if !self.model_present() {
            anyhow::bail!(NOT_DOWNLOADED);
        }
        self.sync_with(root, &learned, false)?;
        let wanted: Vec<String> = topics.iter().flat_map(|t| normalize_topics(t)).collect();
        let candidates: Vec<&(LearnedMemory, String)> = learned
            .iter()
            .filter(|(m, _)| wanted.is_empty() || m.topics.iter().any(|t| wanted.contains(t)))
            .collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let q = format!("{QUERY_PREFIX}{query}");
        let qv = normalized(
            self.with_embedder(false, |e| e.embed(&[q]))?
                .into_iter()
                .next()
                .ok_or_else(|| anyhow::anyhow!("the memory model returned no vector"))?,
        );
        let conn = self.open_index(root)?;
        let mut stmt = conn.prepare("SELECT vector FROM memories WHERE id = ?1")?;
        let mut hits = Vec::new();
        for (m, source) in candidates {
            let Ok(blob) = stmt.query_row([m.id()], |r| r.get::<_, Vec<u8>>(0)) else { continue };
            let v = from_blob(&blob);
            if v.len() != qv.len() {
                continue;
            }
            hits.push(MemoryHit {
                fact: m.fact.clone(),
                topics: m.topics.clone(),
                why: m.why.clone(),
                source: source.clone(),
                score: v.iter().zip(&qv).map(|(a, b)| a * b).sum(),
            });
        }
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(limit.map(|l| l as usize).unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT));
        Ok(hits)
    }
}

fn index_model(conn: &rusqlite::Connection) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = 'model'", [], |r| r.get(0)).ok()
}

fn normalized(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
    v
}

fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Bag of words hashed into a small space: texts that share words
    /// land near each other, which is all ranking needs to be tested --
    /// no weights, no network.
    struct Words;
    impl Embedder for Words {
        fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
            Ok(texts
                .iter()
                .map(|t| {
                    let t = t.strip_prefix(QUERY_PREFIX).unwrap_or(t);
                    let mut v = vec![0f32; 4096];
                    // Four letters and up: "the" and "can" are not what
                    // a question is about.
                    for w in t.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 3) {
                        let h = ring::digest::digest(&ring::digest::SHA256, w.to_lowercase().as_bytes());
                        let h = h.as_ref();
                        v[(h[0] as usize) << 4 | (h[1] as usize & 0xf)] += 1.0;
                    }
                    v
                })
                .collect())
        }
    }

    struct Fixture {
        _dirs: tempfile::TempDir,
        root: PathBuf,
        memories: Memories,
        loads: Arc<AtomicUsize>,
        embedded: Arc<AtomicUsize>,
    }

    struct Counting(Arc<AtomicUsize>);
    impl Embedder for Counting {
        fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
            self.0.fetch_add(texts.len(), Ordering::SeqCst);
            Words.embed(texts)
        }
    }

    /// `downloaded`: whether the weights are already on disk.
    fn fixture(downloaded: bool) -> Fixture {
        let dirs = tempfile::tempdir().unwrap();
        let root = dirs.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        let model_dir = dirs.path().join("models");
        if downloaded {
            std::fs::create_dir_all(&model_dir).unwrap();
            std::fs::write(model_dir.join(READY_MARKER), MODEL_ID).unwrap();
        }
        let loads = Arc::new(AtomicUsize::new(0));
        let embedded = Arc::new(AtomicUsize::new(0));
        let (l, e) = (loads.clone(), embedded.clone());
        let memories = Memories::with_loader(
            dirs.path().join("memory-index"),
            model_dir,
            Box::new(move |_| {
                l.fetch_add(1, Ordering::SeqCst);
                Ok(Box::new(Counting(e.clone())) as Box<dyn Embedder>)
            }),
        );
        Fixture { _dirs: dirs, root, memories, loads, embedded }
    }

    fn write_learned(root: &Path, file: &str, section: &str) {
        std::fs::write(
            root.join(file),
            format!("# Rules\n\n{MARKER_START}\nGuidance.\n\n### Learned\n\n{section}{MARKER_END}\n"),
        )
        .unwrap();
    }

    const CORPUS: &str = "- Never pkill gavin-daemon. (topics: daemon, pty)\n  Why: every other session loses its terminals.\n- Line endings are LF on disk on every OS. (topics: git)\n- The fs-watcher tests are flaky under parallel cargo runs. (topics: tests)\n";

    // -- the shared table -----------------------------------------------

    #[derive(serde::Deserialize)]
    struct ParseCase {
        name: String,
        section: String,
        memories: Vec<LearnedMemory>,
    }

    #[derive(serde::Deserialize)]
    struct Table {
        parse: Vec<ParseCase>,
    }

    #[test]
    fn reads_learned_exactly_as_the_app_does() {
        let table: Table =
            serde_json::from_str(include_str!("../../../test-fixtures/learned-memories/cases.json")).unwrap();
        assert!(table.parse.len() > 5, "the table is there");
        for case in table.parse {
            assert_eq!(parse_learned(&case.section), case.memories, "{}", case.name);
        }
    }

    #[test]
    fn reads_only_the_block_s_learned_section() {
        let content = format!(
            "### Learned\n\n- the human's own, outside the block\n\n{MARKER_START}\nGuidance.\n- not a memory\n\n### Learned\n\n- One. (topics: a)\n{MARKER_END}\n"
        );
        assert_eq!(
            learned_in_file(&content),
            vec![LearnedMemory { fact: "One.".into(), topics: vec!["a".into()], why: None }]
        );
        assert!(learned_in_file("# no block\n").is_empty());
        assert!(learned_in_file(&format!("{MARKER_START}\nGuidance.\n{MARKER_END}\n")).is_empty());
    }

    #[test]
    fn reads_every_instructions_file_once_each() {
        let f = fixture(true);
        write_learned(&f.root, "CLAUDE.md", "- One.\n- Two.\n");
        write_learned(&f.root, "AGENTS.md", "- Two.\n- Three.\n");
        let got: Vec<(String, String)> =
            read_learned(&f.root).into_iter().map(|(m, src)| (m.fact, src)).collect();
        assert_eq!(
            got,
            vec![
                ("One.".into(), "CLAUDE.md".into()),
                ("Two.".into(), "CLAUDE.md".into()),
                ("Three.".into(), "AGENTS.md".into()),
            ]
        );
    }

    #[test]
    fn reads_the_file_config_toml_names_but_never_outside_the_root() {
        let f = fixture(true);
        std::fs::create_dir_all(f.root.join(".gavin-root")).unwrap();
        std::fs::create_dir_all(f.root.join("docs")).unwrap();
        write_learned(&f.root, "docs/RULES.md", "- Configured.\n");
        std::fs::write(f.root.join(".gavin-root/config.toml"), "[agent]\nfile = \"docs/RULES.md\"\n").unwrap();
        assert_eq!(read_learned(&f.root)[0].1, "docs/RULES.md");

        std::fs::write(f.root.join(".gavin-root/config.toml"), "[agent]\nfile = \"../outside.md\"\n").unwrap();
        assert!(configured_file(&f.root).is_none());
    }

    // -- the index --------------------------------------------------------

    #[test]
    fn ranks_the_fact_a_paraphrase_is_about_first() {
        let f = fixture(true);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        let hits = f.memories.search(&f.root, "can I pkill the daemon?", &[], None).unwrap();
        assert_eq!(hits[0].fact, "Never pkill gavin-daemon.");
        assert_eq!(hits[0].topics, vec!["daemon", "pty"]);
        assert_eq!(hits[0].why.as_deref(), Some("every other session loses its terminals."));
        assert_eq!(hits[0].source, "CLAUDE.md");
        assert!(hits.windows(2).all(|w| w[0].score >= w[1].score), "best first");
    }

    #[test]
    fn a_topic_narrows_the_search() {
        let f = fixture(true);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        let hits = f.memories.search(&f.root, "pkill the daemon", &["Git".into()], None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].fact, "Line endings are LF on disk on every OS.");
        assert!(f.memories.search(&f.root, "anything", &["nope".into()], None).unwrap().is_empty());
    }

    #[test]
    fn the_limit_caps_the_answer() {
        let f = fixture(true);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        assert_eq!(f.memories.search(&f.root, "daemon", &[], Some(2)).unwrap().len(), 2);
        assert_eq!(f.memories.search(&f.root, "daemon", &[], Some(0)).unwrap().len(), 1);
    }

    #[test]
    fn nothing_adopted_is_an_empty_answer_even_with_no_model() {
        let f = fixture(false);
        assert!(f.memories.search(&f.root, "anything", &[], None).unwrap().is_empty());
        write_learned(&f.root, "CLAUDE.md", "");
        assert!(f.memories.search(&f.root, "anything", &[], None).unwrap().is_empty());
        assert_eq!(f.loads.load(Ordering::SeqCst), 0, "no model was loaded for it");
    }

    #[test]
    fn a_missing_model_is_a_clear_error_and_never_a_download() {
        let f = fixture(false);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        let err = f.memories.search(&f.root, "daemon", &[], None).unwrap_err().to_string();
        assert!(err.contains("Memory step"), "{err}");
        let err = f.memories.ensure(&f.root, false).unwrap_err().to_string();
        assert!(err.contains("Memory step"), "{err}");
        assert_eq!(f.loads.load(Ordering::SeqCst), 0);
        assert_eq!(f.memories.status(&f.root).model, "absent");
    }

    #[test]
    fn ensure_with_download_fetches_the_model_and_builds_the_index() {
        let f = fixture(false);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        let first = f.memories.ensure(&f.root, true).unwrap();
        assert!(matches!(first.model.as_str(), "downloading" | "ready"), "{first:?}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let status = loop {
            let s = f.memories.status(&f.root);
            if s.model != "downloading" || std::time::Instant::now() > deadline {
                break s;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(
            status,
            MemoryIndexStatus { model: "ready".into(), model_error: None, learned: 3, indexed: 3, in_sync: true }
        );
        assert_eq!(f.loads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failed_download_says_why() {
        let dirs = tempfile::tempdir().unwrap();
        let memories = Memories::with_loader(
            dirs.path().join("memory-index"),
            dirs.path().join("models"),
            Box::new(|_| anyhow::bail!("network unreachable")),
        );
        memories.ensure(dirs.path(), true).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while memories.status(dirs.path()).model == "downloading" && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let status = memories.status(dirs.path());
        assert_eq!(status.model, "failed");
        assert!(status.model_error.unwrap().contains("network unreachable"));
    }

    #[test]
    fn status_reports_drift_without_embedding() {
        let f = fixture(true);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        let s = f.memories.status(&f.root);
        assert_eq!((s.learned, s.indexed, s.in_sync), (3, 0, false));
        assert!(!f.memories.index_path(&f.root).exists(), "a status read creates no index");
        f.memories.ensure(&f.root, false).unwrap();
        let s = f.memories.status(&f.root);
        assert_eq!((s.learned, s.indexed, s.in_sync), (3, 3, true));
        assert_eq!(f.embedded.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_hand_edit_heals_on_the_next_search_embedding_only_what_changed() {
        let f = fixture(true);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        f.memories.ensure(&f.root, false).unwrap();
        assert_eq!(f.embedded.load(Ordering::SeqCst), 3);

        // The human rewrites one bullet and deletes another by hand.
        write_learned(
            &f.root,
            "CLAUDE.md",
            "- Never pkill gavin-daemon. (topics: daemon, pty)\n  Why: every other session loses its terminals.\n- Use git ls-files --eol to find CRLF files. (topics: git)\n",
        );
        assert!(!f.memories.status(&f.root).in_sync);
        let hits = f.memories.search(&f.root, "find CRLF files", &[], None).unwrap();
        assert_eq!(hits[0].fact, "Use git ls-files --eol to find CRLF files.");
        assert_eq!(hits.len(), 2, "the deleted bullet is gone from the index");
        // One new bullet, plus the query.
        assert_eq!(f.embedded.load(Ordering::SeqCst), 3 + 1 + 1);
        let s = f.memories.status(&f.root);
        assert_eq!((s.learned, s.indexed, s.in_sync), (2, 2, true));
    }

    #[test]
    fn emptying_learned_empties_the_index_without_a_model() {
        let f = fixture(true);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        f.memories.ensure(&f.root, false).unwrap();
        write_learned(&f.root, "CLAUDE.md", "");
        assert!(f.memories.search(&f.root, "daemon", &[], None).unwrap().is_empty());
        assert!(f.memories.indexed_ids(&f.root).is_empty());
    }

    #[test]
    fn an_index_from_another_model_is_rebuilt_not_mixed() {
        let f = fixture(true);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        f.memories.ensure(&f.root, false).unwrap();
        let conn = f.memories.open_index(&f.root).unwrap();
        conn.execute("UPDATE meta SET value = 'some-older-model' WHERE key = 'model'", []).unwrap();
        drop(conn);
        assert!(f.memories.indexed_ids(&f.root).is_empty());
        assert!(!f.memories.status(&f.root).in_sync);
        f.memories.ensure(&f.root, false).unwrap();
        assert_eq!(f.memories.indexed_ids(&f.root).len(), 3, "rebuilt under this model");
    }

    #[test]
    fn an_empty_query_is_refused() {
        let f = fixture(true);
        assert!(f.memories.search(&f.root, "  ", &[], None).is_err());
    }

    /// The real model, end to end: downloads the weights (network), so it
    /// runs only when asked -- `cargo test -p gavin-daemon -- --ignored
    /// real_bge`.
    #[test]
    #[ignore]
    fn real_bge_ranks_a_paraphrase() {
        let dirs = tempfile::tempdir().unwrap();
        let root = dirs.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        write_learned(&root, "CLAUDE.md", CORPUS);
        let model_dir = std::env::var_os("GAVIN_TEST_MODEL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs.path().join("models"));
        let memories = Memories::with_loader(dirs.path().join("memory-index"), model_dir, Box::new(load_bge));
        memories.with_embedder(true, |_| Ok(())).unwrap();
        let hits = memories.search(&root, "is it safe to kill the background server process?", &[], None).unwrap();
        assert_eq!(hits[0].fact, "Never pkill gavin-daemon.", "{hits:?}");
        let hits = memories.search(&root, "windows carriage returns in files", &[], None).unwrap();
        assert_eq!(hits[0].fact, "Line endings are LF on disk on every OS.", "{hits:?}");
    }
}
