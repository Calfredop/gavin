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
//!
//! The same index file holds a second table for the workspace's CARDS
//! (v71, `gavin_find_cards`): each card's title and the opening of its
//! body, keyed by a digest of exactly that text, so a card that only
//! moved -- filed under done/, archived -- keeps its vector, and an edit
//! is a removal plus an addition, like a memory's. A workspace has
//! hundreds of cards rather than tens, which is still a brute-force
//! cosine. A workspace the app watches is kept up in the background, a
//! scan at a time (`index_cards_in_background`), so a search normally
//! finds every card embedded; one nobody watches embeds what is missing
//! when it is searched. How the cosine and the card's words are fused
//! into one order is `card_rank`'s.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use protocol::{CardHit, GavinTree, MemoryHit, MemoryIndexStatus, PlanFileInfo};

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

/// How much of a card's body is embedded beside its title. The opening
/// is where a card says what it is about -- the rest is checklists and
/// notes that dilute it. Measured on this repo's 624 cards with a release
/// daemon: 1200 characters took 43 s to embed on the first search and
/// ranked worse than 600, which took 22 s.
const CARD_BODY_CHARS: usize = 600;

/// Passages embedded per call to the model. Shortest first, so a batch
/// pads to a length near its own rather than to the longest card in the
/// workspace -- the tokenizer pads every passage in a batch to the
/// longest one. Measured on this repo's 624 cards with the real model:
/// unsorted in one call of 256 took 35 s, sorted in batches of 256 took
/// 22 s, of 32 took 16.5 s, and of 8 took 20 s. Small batches also hand
/// the model back between them, so a memory search waiting on a card
/// sync waits one batch rather than a whole workspace.
const EMBED_BATCH: usize = 32;

/// How long the model stays loaded after it was last used. Loaded, it
/// costs the daemon about 230 MB of footprint, and about 610 MB once it
/// has embedded a workspace's cards in batches -- for a daemon that is
/// otherwise a few MB -- while loading it again takes about 0.1 s.
/// Measured with a release daemon on an M1 Max, on this repo's cards.
const MODEL_IDLE: std::time::Duration = std::time::Duration::from_secs(60);

/// Most hits one `search_cards` returns, so the answer stays well under
/// `MAX_LINE_BYTES` even with long paths. gavin-mcp applies its other
/// criteria to what comes back, so on a workspace past this many cards
/// they narrow the best 2000 rather than every card.
const MAX_CARD_HITS: usize = 2000;

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

/// What a card is embedded as: its title, then the opening of its body.
fn card_passage(title: &str, body: &str) -> String {
    let body: String = body.trim().chars().take(CARD_BODY_CHARS).collect();
    if body.is_empty() {
        title.to_string()
    } else {
        format!("{title}\n\n{body}")
    }
}

/// A card's row key: the text it was embedded from, not its path, which
/// changes every time the card is filed.
fn passage_id(passage: &str) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, passage.as_bytes()).as_ref())
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
    /// Loaded on first use and dropped again once it has sat idle for
    /// `idle` (`unload_when_idle`).
    embedder: Mutex<Option<Box<dyn Embedder>>>,
    /// When the model last finished a call, and whether a thread is
    /// watching for it to go idle.
    last_used: Mutex<Option<std::time::Instant>>,
    unloader: Mutex<bool>,
    idle: std::time::Duration,
    download: Mutex<Download>,
    /// One card sync per index at a time. A search arriving while the
    /// background embeds waits it out and then finds nothing left to
    /// embed, rather than embedding the same cards beside it. Keyed by
    /// index file, so two spellings of one root share a lock.
    card_sync: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    /// The background card index, per index file.
    card_jobs: Mutex<HashMap<PathBuf, CardJob>>,
}

/// One root's background card index: whether a sync is running, the tree
/// to sync next when it finishes, and which tree was last handed in.
#[derive(Default)]
struct CardJob {
    running: bool,
    next: Option<GavinTree>,
    fingerprint: Option<u64>,
}

/// Which cards a tree holds and when each was last written. Two scans
/// with the same fingerprint have the same cards to embed, so the second
/// starts nothing. Whole seconds, like `modified_at`: an edit landing in
/// the same second as the one before it is caught by the next search's
/// own sync instead.
fn tree_fingerprint(tree: &GavinTree) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    tree.root_path.hash(&mut h);
    for plan in tree.contexts.iter().flat_map(|c| &c.plans) {
        (&plan.path, plan.modified_at, &plan.title).hash(&mut h);
    }
    h.finish()
}

/// (path, id) for each card, and id -> passage once per distinct text:
/// two cards that say the same thing share a row.
fn card_rows(cards: &[(PlanFileInfo, String)]) -> (Vec<(String, String)>, HashMap<String, String>) {
    let mut rows = Vec::with_capacity(cards.len());
    let mut want = HashMap::new();
    for (info, body) in cards {
        let passage = card_passage(&info.title, body);
        let id = passage_id(&passage);
        rows.push((info.path.clone(), id.clone()));
        want.insert(id, passage);
    }
    (rows, want)
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
            last_used: Mutex::new(None),
            unloader: Mutex::new(false),
            idle: MODEL_IDLE,
            download: Mutex::new(Download::Idle),
            card_sync: Mutex::new(HashMap::new()),
            card_jobs: Mutex::new(HashMap::new()),
        }))
    }

    /// `with_loader`, with the model dropped after `idle` rather than a
    /// minute, so a test can watch it go.
    #[cfg(test)]
    fn with_idle(mut self, idle: std::time::Duration) -> Self {
        Arc::get_mut(&mut self.0).expect("not shared yet").idle = idle;
        self
    }

    /// Drops the model once nothing has used it for `idle`, on a thread
    /// that lives only while a model is loaded. `try_lock`, because a
    /// model in use is not idle whatever the clock says. The flag goes
    /// down while the model's lock is still held, so a load racing the
    /// drop always starts a watcher of its own.
    fn unload_when_idle(&self) {
        {
            let mut running = self.0.unloader.lock().unwrap();
            if *running {
                return;
            }
            *running = true;
        }
        let weak = Arc::downgrade(&self.0);
        let idle = self.0.idle;
        std::thread::spawn(move || loop {
            std::thread::sleep(idle / 4);
            let Some(inner) = weak.upgrade() else { return };
            let last = *inner.last_used.lock().unwrap();
            if last.is_some_and(|t| t.elapsed() < idle) {
                continue;
            }
            let dropped = match inner.embedder.try_lock() {
                Ok(mut slot) => {
                    *slot = None;
                    *inner.unloader.lock().unwrap() = false;
                    true
                }
                Err(_) => false,
            };
            if dropped {
                return;
            }
        });
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
            self.unload_when_idle();
        }
        let result = f(slot.as_mut().expect("loaded above").as_mut());
        *self.0.last_used.lock().unwrap() = Some(std::time::Instant::now());
        result
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
             );
             CREATE TABLE IF NOT EXISTS cards (
                 id TEXT PRIMARY KEY,
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
            tx.execute("DELETE FROM cards", [])?;
            tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('model', ?1)", [MODEL_ID])?;
        }
        tx.commit()?;
        Ok(conn)
    }

    /// The memory ids an index holds; see `ids_in`.
    fn indexed_ids(&self, root: &Path) -> HashSet<String> {
        self.ids_in(root, "memories")
    }

    /// The ids `table` holds, without creating an index for a root that
    /// has never had one.
    /// Writes nothing: an index from another model reads as empty, and
    /// the next sync resets it. So does an index a daemon from before the
    /// table wrote -- the query fails and the next sync creates it.
    fn ids_in(&self, root: &Path, table: &str) -> HashSet<String> {
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
        let Ok(mut stmt) = conn.prepare(&format!("SELECT id FROM {table}")) else { return HashSet::new() };
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
        let mut conn = self.open_index(root)?;
        let tx = conn.transaction()?;
        for id in stale {
            tx.execute("DELETE FROM memories WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        let facts: HashMap<&String, &str> = missing.iter().map(|(id, m)| (*id, m.fact.as_str())).collect();
        let items = missing.iter().map(|(id, m)| ((*id).clone(), m.passage())).collect();
        self.embed_batches(items, download, |batch, vectors| {
            let tx = conn.transaction()?;
            for ((id, _), v) in batch.iter().zip(vectors) {
                tx.execute(
                    "INSERT OR REPLACE INTO memories (id, fact, vector) VALUES (?1, ?2, ?3)",
                    rusqlite::params![id, facts[id], to_blob(&normalized(v))],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Embeds `items` (id, passage) shortest first, `EMBED_BATCH` at a
    /// time, handing each batch's vectors to `write` as they land -- so a
    /// sync cut short keeps what it finished, and the next one embeds only
    /// the rest.
    fn embed_batches(
        &self,
        mut items: Vec<(String, String)>,
        download: bool,
        mut write: impl FnMut(&[(String, String)], Vec<Vec<f32>>) -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        items.sort_by_key(|(_, passage)| passage.len());
        for batch in items.chunks(EMBED_BATCH) {
            let passages: Vec<String> = batch.iter().map(|(_, p)| p.clone()).collect();
            let vectors = self.with_embedder(download, |e| e.embed(&passages))?;
            write(batch, vectors)?;
        }
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
        let qv = self.query_vector(query)?;
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

    /// `query` as a unit vector, with BGE's retrieval instruction.
    fn query_vector(&self, query: &str) -> anyhow::Result<Vec<f32>> {
        let q = format!("{QUERY_PREFIX}{query}");
        Ok(normalized(
            self.with_embedder(false, |e| e.embed(&[q]))?
                .into_iter()
                .next()
                .ok_or_else(|| anyhow::anyhow!("the memory model returned no vector"))?,
        ))
    }

    /// Makes the cards table hold exactly `want` (id -> passage), the way
    /// `sync_with` does for memories: drops what is no longer there,
    /// embeds what is new, and embeds nothing when nothing is.
    fn sync_cards(&self, root: &Path, want: &HashMap<String, String>) -> anyhow::Result<()> {
        let lock = self.0.card_sync.lock().unwrap().entry(self.index_path(root)).or_default().clone();
        let _one_at_a_time = lock.lock().map_err(|_| anyhow::anyhow!("card index lock poisoned"))?;
        let have = self.ids_in(root, "cards");
        let stale: Vec<&String> = have.iter().filter(|id| !want.contains_key(*id)).collect();
        let missing: Vec<(String, String)> =
            want.iter().filter(|(id, _)| !have.contains(*id)).map(|(id, p)| (id.clone(), p.clone())).collect();
        if stale.is_empty() && missing.is_empty() {
            return Ok(());
        }
        let mut conn = self.open_index(root)?;
        let tx = conn.transaction()?;
        for id in stale {
            tx.execute("DELETE FROM cards WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        self.embed_batches(missing, false, |batch, vectors| {
            let tx = conn.transaction()?;
            for ((id, _), v) in batch.iter().zip(vectors) {
                tx.execute(
                    "INSERT OR REPLACE INTO cards (id, vector) VALUES (?1, ?2)",
                    rusqlite::params![id, to_blob(&normalized(v))],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Brings `tree`'s cards into the index on a thread of its own: what
    /// a watched workspace's every scan calls, so a search finds its cards
    /// embedded rather than embedding them while an agent waits.
    ///
    /// Never downloads the model -- with none on disk this does nothing.
    /// A tree whose fingerprint matches the last one handed in starts
    /// nothing, and one arriving while a sync runs waits for it, replacing
    /// any tree already waiting: only the newest is worth embedding.
    pub fn index_cards_in_background(&self, tree: &GavinTree) {
        if !self.model_present() {
            return;
        }
        let key = self.index_path(Path::new(&tree.root_path));
        let fingerprint = tree_fingerprint(tree);
        let mut jobs = self.0.card_jobs.lock().unwrap();
        let job = jobs.entry(key.clone()).or_default();
        if job.fingerprint == Some(fingerprint) {
            return;
        }
        job.fingerprint = Some(fingerprint);
        if job.running {
            job.next = Some(tree.clone());
            return;
        }
        job.running = true;
        drop(jobs);
        let me = self.clone();
        let tree = tree.clone();
        std::thread::spawn(move || me.run_card_job(key, tree));
    }

    fn run_card_job(&self, key: PathBuf, mut tree: GavinTree) {
        loop {
            let root = PathBuf::from(&tree.root_path);
            let (_, want) = card_rows(&crate::gavin::card_bodies(tree));
            let result = self.sync_cards(&root, &want);
            let mut jobs = self.0.card_jobs.lock().unwrap();
            let job = jobs.entry(key.clone()).or_default();
            if let Err(e) = result {
                eprintln!("gavin-daemon: card index for {}: {e:#}", root.display());
                // So the next scan tries again, even of the same tree.
                job.fingerprint = None;
            }
            match job.next.take() {
                Some(next) => tree = next,
                None => {
                    job.running = false;
                    return;
                }
            }
        }
    }

    /// `root`'s cards best first for `query` -- by meaning and by words,
    /// fused (`card_rank`) -- archived ones included, every card when
    /// `limit` is None (up to `MAX_CARD_HITS`). Each hit's score is its
    /// cosine, so a later hit can carry a higher one. Brings the cards
    /// table up to the files first.
    pub fn search_cards(&self, root: &Path, query: &str, limit: Option<u32>) -> anyhow::Result<Vec<CardHit>> {
        let query = query.trim();
        if query.is_empty() {
            anyhow::bail!("the query is empty -- say what you are looking for");
        }
        let cards = crate::gavin::cards_with_bodies(root);
        let (rows, want) = card_rows(&cards);
        if cards.is_empty() {
            // No cards is an answer, and needs no model -- leftovers from
            // cards since deleted go now, like an emptied `### Learned`.
            self.sync_cards(root, &want)?;
            return Ok(Vec::new());
        }
        if !self.model_present() {
            anyhow::bail!(NOT_DOWNLOADED);
        }
        self.sync_cards(root, &want)?;
        let qv = self.query_vector(query)?;
        let conn = self.open_index(root)?;
        let vectors: HashMap<String, Vec<f32>> = conn
            .prepare("SELECT id, vector FROM cards")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, from_blob(&r.get::<_, Vec<u8>>(1)?))))?
            .filter_map(Result::ok)
            .filter(|(_, v)| v.len() == qv.len())
            .collect();
        // Only cards with a vector take part: after the sync above that is
        // every card, short of a write racing it.
        let (mut ranked, mut meaning, mut texts) = (Vec::new(), Vec::new(), Vec::new());
        for ((path, id), (info, body)) in rows.into_iter().zip(&cards) {
            let Some(v) = vectors.get(&id) else { continue };
            meaning.push(v.iter().zip(&qv).map(|(a, b)| a * b).sum::<f32>());
            texts.push(crate::card_rank::lexical_text(&info.title, &info.file_name, body));
            ranked.push(path);
        }
        let lexical = crate::card_rank::bm25(query, &texts);
        let mut hits: Vec<CardHit> = crate::card_rank::fuse(&meaning, &lexical)
            .into_iter()
            .map(|i| CardHit { path: ranked[i].clone(), score: meaning[i] })
            .collect();
        hits.truncate(limit.map(|l| (l as usize).max(1)).unwrap_or(MAX_CARD_HITS).min(MAX_CARD_HITS));
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
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A `Memories` with the model "downloaded" and a word-hashing
    /// embedder in its place, for tests outside this module, with the
    /// number of passages it has embedded.
    pub(crate) fn fake_memories(dir: &Path) -> (Memories, Arc<AtomicUsize>) {
        let model_dir = dir.join("models");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join(READY_MARKER), MODEL_ID).unwrap();
        let embedded = Arc::new(AtomicUsize::new(0));
        let e = embedded.clone();
        let memories = Memories::with_loader(
            dir.join("memory-index"),
            model_dir,
            Box::new(move |_| Ok(Box::new(Counting(e.clone())) as Box<dyn Embedder>)),
        );
        (memories, embedded)
    }

    /// Polls until `done` holds, for the background index's thread.
    pub(crate) fn eventually(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !done() {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

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
        assert!(f.memories.search_cards(&f.root, "  ", None).is_err());
    }

    // -- cards --------------------------------------------------------------

    fn write_card(root: &Path, rel: &str, title: &str, body: &str) -> String {
        let path = root.join(".gavin-root/plans").join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("---\ntitle: {title}\nkind: task\n---\n{body}\n")).unwrap();
        protocol::wire_path(&path)
    }

    fn hit_paths(hits: &[CardHit]) -> Vec<&str> {
        hits.iter().map(|h| h.path.as_str()).collect()
    }

    #[test]
    fn cards_rank_by_title_and_body_archived_ones_included() {
        let f = fixture(true);
        let login = write_card(&f.root, "login.md", "Fix the login flow", "The redirect loops after OAuth.");
        let drag = write_card(
            &f.root,
            "archive/drag.md",
            "Kanban polish",
            "Dragging cards between columns drops them.",
        );
        let hits = f.memories.search_cards(&f.root, "dragging cards between columns", None).unwrap();
        assert_eq!(hit_paths(&hits), vec![drag.as_str(), login.as_str()], "every card, best first");
        assert!(hits[0].score > hits[1].score);
        let hits = f.memories.search_cards(&f.root, "login redirect", Some(1)).unwrap();
        assert_eq!(hit_paths(&hits), vec![login.as_str()]);
    }

    #[test]
    fn a_filed_card_keeps_its_vector_and_an_edit_embeds_only_that_card() {
        let f = fixture(true);
        let plans = f.root.join(".gavin-root/plans");
        write_card(&f.root, "a.md", "Fix the login flow", "Redirect loops.");
        write_card(&f.root, "b.md", "Kanban polish", "Dragging cards.");
        f.memories.search_cards(&f.root, "login", None).unwrap();
        assert_eq!(f.embedded.load(Ordering::SeqCst), 2 + 1, "two cards and the query");

        // Filed under done/: same text, new path.
        std::fs::create_dir_all(plans.join("done")).unwrap();
        std::fs::rename(plans.join("a.md"), plans.join("done/a.md")).unwrap();
        let hits = f.memories.search_cards(&f.root, "login", None).unwrap();
        assert!(hits[0].path.ends_with("/plans/done/a.md"), "{hits:?}");
        assert_eq!(f.embedded.load(Ordering::SeqCst), 3 + 1, "only the query");

        write_card(&f.root, "b.md", "Kanban polish", "Dragging cards between columns.");
        f.memories.search_cards(&f.root, "login", None).unwrap();
        assert_eq!(f.embedded.load(Ordering::SeqCst), 4 + 1 + 1, "the edited card and the query");
        assert_eq!(f.memories.ids_in(&f.root, "cards").len(), 2, "the old text's row is gone");
    }

    #[test]
    fn no_cards_needs_no_model_and_cards_need_one_never_a_download() {
        let f = fixture(false);
        assert!(f.memories.search_cards(&f.root, "anything", None).unwrap().is_empty());
        write_card(&f.root, "a.md", "Fix the login flow", "");
        let err = f.memories.search_cards(&f.root, "login", None).unwrap_err().to_string();
        assert!(err.contains("Memory step"), "{err}");
        assert_eq!(f.loads.load(Ordering::SeqCst), 0);
    }

    /// What the model is handed, call by call: each call's passage lengths.
    struct Recording(Arc<Mutex<Vec<Vec<usize>>>>);
    impl Embedder for Recording {
        fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
            self.0.lock().unwrap().push(texts.iter().map(String::len).collect());
            Words.embed(texts)
        }
    }

    #[test]
    fn cards_are_embedded_shortest_first_in_batches_of_thirty_two() {
        let dirs = tempfile::tempdir().unwrap();
        let root = dirs.path().join("ws");
        let model_dir = dirs.path().join("models");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join(READY_MARKER), MODEL_ID).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let c = calls.clone();
        let memories = Memories::with_loader(
            dirs.path().join("memory-index"),
            model_dir,
            Box::new(move |_| Ok(Box::new(Recording(c.clone())) as Box<dyn Embedder>)),
        );
        // Lengths deliberately out of order on disk.
        for i in 0..70 {
            write_card(&root, &format!("c{i}.md"), &format!("Card {i}"), &"word ".repeat((i * 37) % 70));
        }
        memories.search_cards(&root, "word", None).unwrap();
        let calls = calls.lock().unwrap();
        let cards: Vec<&Vec<usize>> = calls.iter().filter(|c| c.len() > 1).collect();
        assert_eq!(cards.iter().map(|c| c.len()).collect::<Vec<_>>(), vec![32, 32, 6], "{calls:?}");
        let lengths: Vec<usize> = cards.iter().flat_map(|c| c.iter().copied()).collect();
        assert!(lengths.windows(2).all(|w| w[0] <= w[1]), "shortest first: {lengths:?}");
    }

    #[test]
    fn a_tree_handed_in_is_indexed_in_the_background_and_a_search_then_embeds_only_the_query() {
        let f = fixture(true);
        write_card(&f.root, "a.md", "Fix the login flow", "Redirect loops.");
        write_card(&f.root, "archive/b.md", "Kanban polish", "Dragging cards.");
        f.memories.index_cards_in_background(&crate::gavin::scan_root(&f.root));
        eventually("two cards indexed", || f.memories.ids_in(&f.root, "cards").len() == 2);
        assert_eq!(f.embedded.load(Ordering::SeqCst), 2);
        let hits = f.memories.search_cards(&f.root, "login", None).unwrap();
        assert!(hits[0].path.ends_with("/a.md"), "{hits:?}");
        assert_eq!(f.embedded.load(Ordering::SeqCst), 3, "only the query");
    }

    #[test]
    fn the_same_tree_twice_starts_nothing_and_a_new_card_embeds_only_itself() {
        let f = fixture(true);
        write_card(&f.root, "a.md", "Fix the login flow", "Redirect loops.");
        let tree = crate::gavin::scan_root(&f.root);
        f.memories.index_cards_in_background(&tree);
        eventually("one card indexed", || f.memories.ids_in(&f.root, "cards").len() == 1);
        f.memories.index_cards_in_background(&tree);
        write_card(&f.root, "b.md", "Kanban polish", "Dragging cards.");
        f.memories.index_cards_in_background(&crate::gavin::scan_root(&f.root));
        eventually("two cards indexed", || f.memories.ids_in(&f.root, "cards").len() == 2);
        // Let a stray second sync of the first tree show itself, if any.
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(f.embedded.load(Ordering::SeqCst), 2, "each card once");
    }

    #[test]
    fn nothing_is_indexed_in_the_background_without_a_model() {
        let f = fixture(false);
        write_card(&f.root, "a.md", "Fix the login flow", "");
        f.memories.index_cards_in_background(&crate::gavin::scan_root(&f.root));
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(f.loads.load(Ordering::SeqCst), 0, "no model loaded, none downloaded");
        assert!(!f.memories.index_path(&f.root).exists());
    }

    /// The labelled queries in `test-fixtures/card-search/queries.json`
    /// against THIS repo's own cards, through the real model and the
    /// shipped ranking: the yardstick `card_rank`'s weights were chosen
    /// by. Network for the weights, and it embeds every card in the repo,
    /// so it runs only when asked -- `cargo test -p gavin-daemon --
    /// --ignored real_bge_ranks`. A query whose card has since been
    /// renamed or deleted fails by name; fix the table.
    #[test]
    #[ignore]
    fn real_bge_ranks_this_repo_s_cards_for_the_labelled_queries() {
        #[derive(serde::Deserialize)]
        struct Query {
            q: String,
            expect: Vec<String>,
        }
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let queries: Vec<Query> =
            serde_json::from_str(include_str!("../../../test-fixtures/card-search/queries.json")).unwrap();
        let dirs = tempfile::tempdir().unwrap();
        let model_dir = std::env::var_os("GAVIN_TEST_MODEL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs.path().join("models"));
        let memories = Memories::with_loader(dirs.path().join("memory-index"), model_dir, Box::new(load_bge));
        memories.with_embedder(true, |_| Ok(())).unwrap();
        let names: HashSet<String> = crate::gavin::cards_with_bodies(&repo).into_iter().map(|(i, _)| i.file_name).collect();
        let (mut mrr, mut first, mut top5, mut top10) = (0f32, 0, 0, 0);
        for query in &queries {
            for name in &query.expect {
                assert!(names.contains(name), "{name} is no longer a card here -- fix the table");
            }
            let hits = memories.search_cards(&repo, &query.q, None).unwrap();
            let rank = 1 + hits
                .iter()
                .position(|h| query.expect.iter().any(|n| h.path.ends_with(&format!("/{n}"))))
                .unwrap();
            eprintln!("{rank:>4}  {}", query.q);
            mrr += 1.0 / rank as f32;
            first += (rank == 1) as usize;
            top5 += (rank <= 5) as usize;
            top10 += (rank <= 10) as usize;
        }
        let n = queries.len();
        mrr /= n as f32;
        eprintln!("MRR {mrr:.3}  first {first}/{n}  top 5 {top5}/{n}  top 10 {top10}/{n}");
        assert!(mrr >= 0.85, "MRR {mrr:.3}");
        assert_eq!(top10, n, "every card a query means is in its top ten");
    }

    #[test]
    fn an_idle_model_is_dropped_and_loaded_again_when_next_needed() {
        let mut f = fixture(true);
        f.memories = f.memories.with_idle(std::time::Duration::from_millis(40));
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        f.memories.search(&f.root, "daemon", &[], None).unwrap();
        assert_eq!(f.loads.load(Ordering::SeqCst), 1);
        eventually("the model dropped", || f.memories.0.embedder.lock().unwrap().is_none());
        assert!(f.memories.model_present(), "dropped is not deleted");
        f.memories.search(&f.root, "daemon", &[], None).unwrap();
        assert_eq!(f.loads.load(Ordering::SeqCst), 2);
    }

    /// The cards table arrived after the index did. `CREATE TABLE IF NOT
    /// EXISTS` does add a missing TABLE to an existing file -- it is a
    /// missing COLUMN it cannot add -- and this holds that against a
    /// file built by hand with the v60 schema.
    #[test]
    fn an_index_from_before_the_cards_table_gains_it() {
        let f = fixture(true);
        write_learned(&f.root, "CLAUDE.md", CORPUS);
        std::fs::create_dir_all(f.memories.index_path(&f.root).parent().unwrap()).unwrap();
        let conn = rusqlite::Connection::open(f.memories.index_path(&f.root)).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE memories (id TEXT PRIMARY KEY, fact TEXT NOT NULL, vector BLOB NOT NULL);
             INSERT INTO meta (key, value) VALUES ('model', '{MODEL_ID}');"
        ))
        .unwrap();
        drop(conn);
        assert!(f.memories.ids_in(&f.root, "cards").is_empty(), "no table reads as empty");
        let login = write_card(&f.root, "a.md", "Fix the login flow", "");
        let hits = f.memories.search_cards(&f.root, "login flow", None).unwrap();
        assert_eq!(hit_paths(&hits), vec![login.as_str()]);
        assert_eq!(f.memories.search(&f.root, "pkill the daemon", &[], None).unwrap()[0].fact, "Never pkill gavin-daemon.");
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

    /// The real model on cards: a query that shares no word with the card
    /// it means still finds it first, archived or not. Network, like the
    /// test above -- `cargo test -p gavin-daemon -- --ignored real_bge`.
    #[test]
    #[ignore]
    fn real_bge_finds_a_card_by_what_it_is_about() {
        let dirs = tempfile::tempdir().unwrap();
        let root = dirs.path().join("ws");
        let tree = write_card(
            &root,
            "archive/tree-size.md",
            "gavin_get_tree dumps the whole board",
            "On a workspace with a long archive it ran to 457,000 characters and spilled to a file.",
        );
        let login = write_card(&root, "login.md", "Fix the login flow", "The OAuth redirect loops forever.");
        write_card(&root, "drag.md", "Kanban drag bug", "Dropping a card on another column loses it.");
        let model_dir = std::env::var_os("GAVIN_TEST_MODEL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs.path().join("models"));
        let memories = Memories::with_loader(dirs.path().join("memory-index"), model_dir, Box::new(load_bge));
        memories.with_embedder(true, |_| Ok(())).unwrap();
        let hits = memories.search_cards(&root, "the tool's answer is too large to read", None).unwrap();
        assert_eq!(hits[0].path, tree, "{hits:?}");
        let hits = memories.search_cards(&root, "signing in sends me round in circles", None).unwrap();
        assert_eq!(hits[0].path, login, "{hits:?}");
    }
}
