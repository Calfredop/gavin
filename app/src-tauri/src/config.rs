use crate::layout::LayoutNode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub name: String,
    pub layout: LayoutNode,
    /// The leaf (pane) last focused while this page was active. Kept in
    /// sync with the frontend's live focus while this page IS the active
    /// one; simply retained otherwise. Lets a cross-page "add as tab" drag
    /// (a later plan) target a well-defined pane even in a page that isn't
    /// currently rendered.
    pub focused_session_id: Option<String>,
    /// When this page was pinned to the top of its workspace's list,
    /// epoch milliseconds. Absent means not pinned.
    ///
    /// A timestamp rather than a boolean because "on top" stops being a
    /// position as soon as there are two of them, and the stored order
    /// cannot answer it: pinning deliberately does NOT reorder `pages`,
    /// or unpinning would have nowhere to put the row back. The moment
    /// the human pinned it is the one ordering they already have in
    /// mind -- the row pinned first stays the row at the top.
    ///
    /// Written by the frontend (which owns the clock) through the
    /// ordinary workspaces save, like `Workspace::last_active_at`, so an
    /// older config simply loads with it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<i64>,
}

/// Well-known id for the always-present "Unfiled" pseudo-workspace -- a
/// pinned, non-closable, non-renameable workspace for pages the user
/// hasn't organized into a real workspace yet. `session.rs`'s bootstrap()
/// ensures a workspace with this exact id always exists. Must match the
/// frontend's own copy of this constant exactly
/// (app/src/lib/workspace.ts's UNFILED_WORKSPACE_ID).
pub const UNFILED_WORKSPACE_ID: &str = "__unfiled__";

/// The pinned workspace's display name. The id above stays "__unfiled__"
/// forever -- changing it orphans every page in every existing
/// config.json -- but the label is only a label, and "Scratchpad" says
/// what the drawer is FOR rather than what its contents are not. Existing
/// configs are migrated on load by session::rename_legacy_unfiled.
pub const SCRATCHPAD_WORKSPACE_NAME: &str = "Scratchpad";

/// The name SCRATCHPAD_WORKSPACE_NAME replaced. Only the migration reads
/// it: a config whose pinned workspace says anything else was renamed by
/// hand, and a hand-picked name outranks ours.
pub const LEGACY_UNFILED_WORKSPACE_NAME: &str = "Unfiled";

/// Well-known id for the retired dev-only "Smoke Test" workspace. Nothing
/// creates one any more; the id survives only so session::drop_smoketest_
/// workspace can take it back out of a config.json an older debug build
/// already wrote. Removing the constant would leave that workspace in
/// every existing dev config for good, with no build able to explain it.
pub const SMOKETEST_WORKSPACE_ID: &str = "__smoketest__";

/// The range a terminal font size has to fall in to be stored. Must match
/// the frontend's own copy exactly (app/src/lib/terminalFont.ts's
/// MIN/MAX_TERMINAL_FONT_SIZE): both ends of the wire validate, because
/// config.json is a file a user can edit and the value lands in xterm's
/// metrics either way.
pub const MIN_TERMINAL_FONT_SIZE: u16 = 8;
pub const MAX_TERMINAL_FONT_SIZE: u16 = 32;

/// Per-workspace Git tab preferences (spec §1: splitter widths, diff
/// layout, the hunk/line discard confirm opt-out). Crosses to the frontend
/// inside Workspace, hence camelCase.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitViewPrefs {
    #[serde(default)]
    pub nav_width: Option<u32>,
    #[serde(default)]
    pub list_width: Option<u32>,
    /// The Unstaged block's share (0-1) of the two lists' height in the
    /// Changes column; Staged takes the rest. Absent = an even split.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unstaged_share: Option<f64>,
    /// "unified" | "split"
    #[serde(default)]
    pub diff_layout: Option<String>,
    #[serde(default)]
    pub skip_hunk_discard_confirm: bool,
    /// Collapsed sidebar sections, keyed by section id (SP2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_collapsed: Option<HashMap<String, bool>>,
    /// Selected worktree path (SP3); absent = the root checkout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// History graph scope (SP4): all branches when absent/true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_all: Option<bool>,
    /// A "Commit via agent" run that was still going when this config was
    /// written. The run is a HIDDEN daemon session, so nothing else in
    /// this file references its id -- without this the app comes back
    /// from a restart with no way to tell that a second agent would be
    /// committing on top of a first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_commit: Option<AgentCommitRecord>,
}

/// The id of an in-flight hidden commit run, and the checkout it was
/// launched against. The cwd is stored rather than re-derived from
/// `worktree`: switching worktrees mid-run already abandons the run, and
/// by then `worktree` names somewhere else entirely.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommitRecord {
    pub session_id: String,
    pub cwd: String,
    /// How many times gavin has RE-RUN this commit prompt by itself after
    /// a transient failure (v22). A retry, not a resume: a headless run
    /// exits, holds no conversation, and "commit pending changes" is
    /// harmless to repeat -- which is exactly why the same budget rule
    /// applies, bounded at one.
    ///
    /// Here rather than in memory because a hidden run is the one piece
    /// of work in this app that survives the window that started it
    /// (`adoptAgentCommits`), so a counter in the window would reset on
    /// the very event the record exists for.
    #[serde(default)]
    pub retries: u32,
    /// Epoch milliseconds at the launch, for the Git tab's "Committing…
    /// 4m 12s" label. Optional and skipped when absent, so a config
    /// written by a build that predates it still loads, and so this
    /// build writing one does not break a build that does not read it --
    /// a release install and a dev tree share this file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
}

/// The orchestration agent run (a Generate, or one rail's Reorganize)
/// that was still going when this config was written.
///
/// Both requests end in a write of the WHOLE plan -- the prompts tell the
/// agent to send every rail it was not asked about back exactly as it
/// read it -- so a second run started while the first is thinking reads a
/// plan that is about to be replaced, and one of the two arrangements is
/// simply lost. One record per workspace is therefore the invariant, not
/// a simplification: Generate and every rail's wand share the one slot.
///
/// The session is a visible one on the Agents page, so unlike
/// `GitViewPrefs::agent_commit` the layout tree does reference it. What
/// the tree cannot say is WHAT it is doing -- and a button that has to
/// refuse a second run has to name the first.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationAgentRecord {
    pub session_id: String,
    /// The rail being reorganized, or absent for a whole-tab Generate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rail_id: Option<String>,
    /// What to call the run where the human meets it ("Generate",
    /// "Reorganize “backend”"). Stored rather than re-derived: the
    /// rail can be renamed or deleted while its run is still going, and
    /// the button it blocks still has to say what is holding the slot.
    pub label: String,
}

/// A "Develop into a plan…" run that was still going when this config was
/// written: the card being reshaped, and the session doing it.
///
/// Kept here because a develop run deliberately binds NOTHING -- no
/// card<->session binding and no status write, since developing a card is
/// not starting it -- so without this record the app has no way to tell
/// that the card in front of it is about to be rewritten. That is what
/// made it possible to start a second agent on a card whose own file was
/// being replaced under it.
///
/// A list rather than one slot: unlike the orchestration agent, two
/// develop runs on two DIFFERENT cards divide the work rather than
/// overwriting each other. It is the same CARD twice that conflicts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevelopingCardRecord {
    /// Absolute path of the card file being developed.
    pub path: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub pages: Vec<Page>,
    pub active_page_id: Option<String>,
    pub active_view: Option<String>,
    /// The hub tab this workspace was last showing, so returning to the
    /// hub from a terminal reopens it instead of Home. Absent until a
    /// hub tab is opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub_view: Option<String>,
    /// The workspace's bound root directory (agent-orchestration phase).
    /// Optional and never auto-cleared: a missing-on-disk root keeps its
    /// stale value so a remounted volume heals without user action.
    #[serde(default)]
    pub root_path: Option<String>,
    /// The workspace's running main agent session, deliberately OUTSIDE
    /// every page tree (D12). Cleared -- never replaced -- when it turns
    /// out to be dead, so an agent is only ever started deliberately.
    #[serde(default)]
    pub main_session_id: Option<String>,
    /// The orchestration agent run still in flight, if any. Cleared by
    /// the frontend the moment the run's session is gone, interrupted or
    /// idle -- see orchestrationAgent.ts, which owns the whole rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration_agent: Option<OrchestrationAgentRecord>,
    /// The cards this workspace is DEVELOPING right now, one record per
    /// in-flight run. Cleared by the frontend the moment a run's session
    /// is gone, interrupted or idle -- see developingCards.ts, which owns
    /// the rule, and shares it with the orchestration agent slot.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub developing_cards: Vec<DevelopingCardRecord>,
    /// D41 migration only: the pre-settings `agentCommand`, which now
    /// lives in `.gavin-root/config.toml`. Read once at bootstrap,
    /// carried into config.toml, then cleared -- `skip_serializing_if`
    /// means the key disappears from config.json on the next save.
    #[serde(default, rename = "agentCommand", skip_serializing_if = "Option::is_none")]
    pub legacy_agent_command: Option<String>,
    /// Accent colour for this workspace's tab indicator and sidebar
    /// stripe. `#rrggbb`; absent means the default accent. Machine-local
    /// (D35) -- a display preference, like the name.
    #[serde(default)]
    pub color: Option<String>,
    /// Per-workspace notification toggles (D38). Default true so existing
    /// workspaces keep today's behaviour.
    #[serde(default = "default_true")]
    pub notify_needs_input: bool,
    #[serde(default = "default_true")]
    pub notify_finished: bool,
    /// Whether closing a tab asks first. Default true so a close is never
    /// silently destructive; turning it off is the deliberate opt-out for
    /// someone who closes tabs constantly.
    #[serde(default = "default_true")]
    pub confirm_tab_close: bool,
    /// Terminal font size for this workspace's panes. Absent means inherit
    /// `AppConfig::terminal_font_size`, and failing that gavin's own
    /// default -- so absence is a real state, not a stand-in for the
    /// default value. Machine-local (D35) like `color`: a display
    /// preference, not a project fact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_font_size: Option<u16>,
    /// Whether a card filed in this workspace starts carrying the
    /// auto-commit block. Absent means inherit `AppConfig::auto_commit`,
    /// and failing that gavin's own default (off) -- so absence is a real
    /// state, not a stand-in for `false`. Machine-local (D35) like
    /// `color`: whether THIS human wants agents committing for them is a
    /// habit, not a fact about the project, and committing it would hand
    /// the setting to everyone who clones the repo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_commit: Option<bool>,
    /// The main agent cell's share (0-1) of the Home tab's row; the
    /// PRD/Board/Orchestration column takes the rest. Absent means the
    /// split the tab shipped with -- stored as absence rather than as
    /// that number, so changing the shipped split later still reaches
    /// everyone who never dragged the divider. Machine-local (D35) like
    /// `color`: how wide a terminal wants to be on this screen is not a
    /// fact about the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_agent_share: Option<f64>,
    /// Whether gavin may resume this workspace's standalone CARD runs by
    /// itself when their agent breaks (v22). Defaults OFF -- the opposite
    /// of every other toggle here -- because it is CONSENT, not a habit:
    /// a run that restarts itself hours after the human walked away made
    /// a decision that was theirs unless they made it in advance.
    ///
    /// Machine-local, like the notification toggles and the close
    /// confirm, and for the same reason: it says what this human wants
    /// gavin doing while they are away from this machine. A rail's own
    /// opt-in lives on the rail instead (`Rail::auto_resume`), because a
    /// rail is a durable object the human designed and its steps are
    /// shared with every agent that reads the plan.
    #[serde(default)]
    pub auto_resume_runs: bool,
    /// Git tab preferences; None until the user changes something.
    #[serde(default)]
    pub git_view: Option<GitViewPrefs>,
    /// When this workspace was last switched to, epoch milliseconds.
    /// Absent means "never switched to since this field shipped", which
    /// is exactly how the app hub orders it: stamped workspaces newest
    /// first, then the never-stamped ones in their stored order. Written
    /// by the frontend (which owns the clock) through the ordinary
    /// workspaces save, so an older config simply loads with it absent.
    #[serde(default)]
    pub last_active_at: Option<i64>,
    /// This workspace's own pause cycle, overriding the app-wide one.
    /// Absent means INHERIT, which is not the same as off -- a workspace
    /// that wants no pause while the app has one stores a cycle with
    /// `enabled: false`, and `skip_serializing_if` keeps the key out of
    /// config.json entirely for the ordinary inheriting case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_pause: Option<AgentPauseConfig>,
    /// When this workspace was pinned to the top of the sidebar, epoch
    /// milliseconds; absent means not pinned. Same rule and same reason
    /// as `Page::pinned_at`, one level up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<i64>,
    /// This workspace's overrides of the app-wide complexity table,
    /// keyed by the level's written name. Overridden PER LEVEL rather
    /// than wholesale: a workspace that wants its gnarly cards on a
    /// different agent should not have to restate the other four, and a
    /// level with no entry here genuinely means "whatever the app says".
    ///
    /// Machine-local for the same reason as `auto_commit` and
    /// `agent_pause` (D35): which model tier this human spends on a hard
    /// card here is a habit and a subscription fact, not something to
    /// hand everyone who clones the repo. `skip_serializing_if` keeps
    /// the key out of config.json entirely for the ordinary inheriting
    /// case.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub complexity_agents: HashMap<String, ComplexityAgent>,
    /// Whether the human has been ASKED whether gavin's own files belong
    /// in this repo's git history. Not the answer -- that is the ignore
    /// rule in the repo itself (`git::tracking`), which git owns and this
    /// must never shadow.
    ///
    /// It exists because the setup wizard's git step has no other way to
    /// know it is finished: both answers are legitimate, and "tracked"
    /// is indistinguishable on disk from "nobody has decided yet". Same
    /// problem the Superpowers step has, and the same shape of answer --
    /// a recorded word from the human, machine-local, because whether
    /// THIS person has seen a question is not a fact about the project.
    #[serde(default)]
    pub git_tracking_asked: bool,
    /// The digest of this workspace's `.gavin-root/config.toml` execution
    /// keys -- `[agent] command`, `[agent] file`, `[worktree] setup` --
    /// as approved by the human (the frontend's `workspaceTrust.ts` owns
    /// the hash and the comparison). Absent means nothing approved, which
    /// is where a freshly cloned repo starts and where a workspace naming
    /// none of those keys stays.
    ///
    /// config.toml ships with the repository, and those three keys name
    /// what gavin RUNS rather than choosing among rows gavin already
    /// verified. Trusting them because they are on disk trusts whoever
    /// wrote the repo; this records that a person looked at the values.
    ///
    /// Machine-local, like the rest here and more pointedly: a copy of
    /// this in the repo would let the repo vouch for itself.
    /// `skip_serializing_if` keeps the key out of config.json for the
    /// ordinary case of a workspace with nothing to approve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_config_hash: Option<String>,
    /// The human's recorded answer to a distinct SET of foreign MCP
    /// servers `setup_agent_integration` found already declared in this
    /// workspace's target MCP config file (AG-07) -- "keep" (merge
    /// gavin's entry beside them) or "isolate" (refused today, see
    /// `agent_setup::isolate_refusal`) -- and the digest of exactly that
    /// set (`mcpServerTrust.ts` owns the hash and the comparison).
    ///
    /// Same shape and reason as `trusted_config_hash` one field up: a
    /// changed set -- an edited `mcp_file`, a `git pull`, a colleague's
    /// change to the target file -- changes the digest, and the question
    /// is asked again rather than a decision nobody was shown being
    /// replayed. Machine-local for the same reason too: a copy in the
    /// repo would let the repo vouch for itself.
    /// `skip_serializing_if` keeps the key out of config.json for the
    /// ordinary case of a workspace with nothing foreign to decide on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_foreign_servers_choice: Option<McpForeignServersChoice>,
    /// Card path -> the digest of the card CONTENT the human has read
    /// before letting an agent have it (the frontend's `cardReview.ts`
    /// owns the hash and the comparison; AG-01/AG-02).
    ///
    /// A card's body IS the prompt a launch hands an agent, and the board
    /// shows only its title -- so `.gavin-root/plans/*.md` arriving with a
    /// clone would otherwise reach an agent unread on the first Run. This
    /// records that a person looked at exactly this content. A body that
    /// changes stops matching and is asked about again.
    ///
    /// Machine-local, like `trusted_config_hash` above and for the same
    /// reason: a copy of it in the repository would let the repository
    /// vouch for its own cards. `skip_serializing_if` keeps the key out of
    /// config.json until something has actually been reviewed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_cards: Option<std::collections::HashMap<String, String>>,
    /// Whether a card filed in this workspace must be reviewed before its
    /// first Run (the frontend's `cardReview.ts`, AG-01). Absent means
    /// inherit `AppConfig::require_review`, and failing that gavin's own
    /// default (require review) -- so absence is a real state, not a
    /// stand-in for `true`. Machine-local (D35) like `auto_commit`: whether
    /// THIS human wants the gate on this machine is a habit, not a fact
    /// about the project, and committing it would hand the setting to
    /// everyone who clones the repo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_review: Option<bool>,
    /// Whether the human has been ASKED whether this workspace requires
    /// the first-Run review. Not the answer -- `require_review` (or its
    /// absence) is that. Same shape and reason as `git_tracking_asked`:
    /// both answers are legitimate, and leaving the gate on its default is
    /// indistinguishable on disk from nobody having decided yet.
    #[serde(default)]
    pub require_review_asked: bool,
    /// This workspace's own resume flag for the `custom` agent profile
    /// (v38), e.g. `--resume`. Absent means inherit
    /// `AppConfig::custom_resume_args`, and failing that no resume at all
    /// for `custom` -- the same "absence is a real state" shape as
    /// `terminal_font_size`. Deliberately this config.json layer and not
    /// `.gavin-root/config.toml`'s `[agent]` table (`file`/`mcp_file`/
    /// `mcp_format`'s layer): those travel with the repo, but a resume
    /// flag is a fact about the BINARY on this machine, exactly like
    /// `command`/`model_flag` already are for every OTHER profile via
    /// the verified table -- `custom` has no table row to carry one, and
    /// config.toml has no app-wide layer to inherit from. Machine-local
    /// (D35) like `auto_commit`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_resume_args: Option<String>,
    /// This workspace's own fallback chain. Absent means INHERIT the
    /// app-wide `AgentDefaultsConfig::agent_fallback`, which is not the
    /// same as off — a workspace that wants no fallback while the app
    /// has one stores an empty vec, and `skip_serializing_if` keeps the
    /// key out of config.json for the ordinary inheriting case.
    ///
    /// Machine-local like `agent_pause`: which CLI this human spends
    /// when a subscription window is full is a fact about this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_fallback: Option<Vec<String>>,
    /// Profile ids this workspace has completed setup-only arming for
    /// (Integration / Superpowers / skills) without switching the active
    /// agent. The workspace's own profile is armed by init / agent-change,
    /// not this list. Empty is the ordinary case.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub armed_agents: Vec<String>,
    /// Overrides of shipped agent action prompts for this workspace,
    /// keyed by catalog id. Empty inherits the app-wide map on
    /// `AgentDefaultsConfig::action_prompt_overrides` (and then the
    /// shipped default). Machine-local like `auto_commit`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub action_prompt_overrides: HashMap<String, String>,
}

/// One recorded decision on `Workspace::mcp_foreign_servers_choice`.
/// `action` is "keep" or "isolate", passed straight through to
/// `setup_agent_integration`'s `mcp_foreign_choice` -- an unrecognised
/// value there is treated as undecided (`McpForeignChoice::from_str`),
/// so a value written by a newer frontend never makes an older one act
/// on a choice it does not understand.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpForeignServersChoice {
    pub hash: String,
    pub action: String,
}

fn default_true() -> bool {
    true
}

/// A workspace the sidebar X removed, kept only so its daemon rows can
/// be found again. Every such row is keyed by the workspace's id -- a
/// uuid minted at creation and written nowhere on disk -- so re-adding
/// the same folder mints a new id and comes back to an empty board. This
/// record is the only bridge back.
///
/// Written and read entirely by the frontend (which owns the clock and
/// the reclaim prompt); Rust's job is to persist it and carry it through,
/// hence camelCase and the `default` on the field that holds it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemovedWorkspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    /// Epoch milliseconds.
    pub removed_at: i64,
}

/// One persisted board tab: which workspace's board, filtered to which
/// gavin context. Crosses to the frontend via get/set_board_tabs, hence
/// camelCase (verified by the shape test below).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardTabRecord {
    pub workspace_id: String,
    pub context_folder: String,
}

/// One persisted view tab: something a terminal tab asked to see beside
/// itself, living in a pane rather than in a modal. `view` picks which
/// one -- "plan" is a card's detail panel, "changes" the diff of what its
/// run did to the checkout, "followups" the queue of messages waiting for
/// a session's next idle.
///
/// The first two are keyed by `path`, the card they show. The third is
/// keyed by `session_id` and carries an empty `path`: an agent's queue
/// belongs to the SESSION, not to whatever card it happens to be running,
/// and two tabs on one card have two different queues. Everything that
/// walks this map by path -- `retargetCardTabs` for a card that moved,
/// `archiveClose` for one leaving the board -- matches against real card
/// paths, so the empty one is never claimed by either.
///
/// The run's baseline is deliberately NOT stored here. It lives on the
/// card's `card_sessions` binding, which a re-launch replaces; copying it
/// into the tab would pin the pane to a run that no longer exists.
/// Crosses to the frontend via get/set_card_tabs, hence camelCase
/// (verified by the shape test below).
///
/// `session_id` is skipped when absent rather than written as null, so a
/// plan or changes tab serializes to exactly the three keys it always
/// did -- a config written by this build stays readable by one without
/// the field, which is the direction that actually happens when a human
/// runs an older bundle against a config the newer one wrote.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardTabRecord {
    pub workspace_id: String,
    pub path: String,
    pub view: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// A duty cycle: sit out `pause_minutes` of every `period_minutes`, and
/// hold when a probe says a limit window is `limit_percent` full.
///
/// Mirrors `PauseCycle` in `agentPause.ts`, which owns every judgement
/// made from it -- this is storage. Machine-local, like the notification
/// toggles and `auto_resume_runs`: it says what this human wants gavin
/// doing while they are away from THIS machine.
///
/// `anchor_ms` is why the cycle survives everything the card asks it to.
/// It is fixed when the cycle is switched on and never rewritten, so the
/// phase is a pure function of it and the wall clock: a machine that
/// slept for two days, an app that was closed overnight and a frontend
/// that reloaded all resolve to the same answer, because none of them are
/// inputs. Re-anchoring on load would slide the pause forward every
/// launch; re-anchoring on wake would mean a laptop that sleeps often
/// never pauses at all.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPauseConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_period_minutes")]
    pub period_minutes: u32,
    #[serde(default = "default_pause_minutes")]
    pub pause_minutes: u32,
    #[serde(default)]
    pub anchor_ms: i64,
    #[serde(default = "default_limit_percent")]
    pub limit_percent: f64,
    /// Whether a probe's limits may pause work at all. Separate switch
    /// from `enabled`, because the blunt gate and the precise one are
    /// wanted independently: an agent with no probe can only have the
    /// cycle, and somebody who trusts the numbers may want only the
    /// limits.
    #[serde(default = "default_true")]
    pub limit_enabled: bool,
}

/// Five hours, matching the window Claude Code and Codex both meter
/// against, so a pause lands at the end of one window rather than
/// straddling two.
fn default_period_minutes() -> u32 {
    300
}

fn default_pause_minutes() -> u32 {
    10
}

fn default_limit_percent() -> f64 {
    95.0
}

/// The launch wall: how many agent turns may be in flight at once,
/// whether memory pressure holds new ones, and whether it may reclaim
/// the idle agents of cards that are already done.
///
/// Mirrors `LaunchConfig` in `launchGate.ts`, which owns every judgement
/// made from it -- this is storage. Machine-local like `agent_pause`
/// (D35), and for a sharper version of the same reason: how many agents
/// this machine can carry is a fact about its RAM, not about the
/// project, and a 32 GB laptop and a 128 GB desktop opening the same
/// repo must not inherit each other's ceiling.
///
/// `max_in_flight` is an `Option` because BLANK is a real answer: no
/// ceiling at all, which is what somebody with memory to spare wants and
/// what every install had before this shipped. Zero is not that answer
/// and is not expressible -- a ceiling of zero would hold every launch
/// for ever, which is not a setting, it is a broken app.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_in_flight: Option<u32>,
    #[serde(default = "default_true")]
    pub hold_on_pressure: bool,
    /// Whether gavin may close an IDLE agent whose card is already in
    /// the done column when memory runs short (`doneSessionReclaim.ts`
    /// owns the rule). The one thing the wall is allowed to stop, and
    /// it is a bool of its own rather than a mode of `hold_on_pressure`
    /// because the two answer different questions: holding a start
    /// costs nothing, closing a finished agent costs its transcript.
    /// Defaulted so a config.json written before this field parses as
    /// the shipped answer rather than as a refusal.
    #[serde(default = "default_true")]
    pub reclaim_done_sessions: bool,
}

/// Four agents, the pressure hold on, and finished cards' idle agents
/// reclaimable.
///
/// Shipped ON, unlike `agent_pause`, and that asymmetry is the whole
/// point of this card: the pause is a spending preference, and this is
/// the guard that stands between eleven rails and a watchdog reset. A
/// default of "no ceiling" would have shipped the crash again. The
/// reclaim is on for the same reason: a machine at critical pressure
/// with six idle agents of done cards on it is the machine that reboots,
/// and the cost of closing them is a transcript the card can re-launch.
impl Default for LaunchConfig {
    fn default() -> Self {
        Self { max_in_flight: Some(4), hold_on_pressure: true, reclaim_done_sessions: true }
    }
}

/// One complexity level's answer to "which agent, at which model".
/// Mirrors `ComplexityAgent` in `complexity.ts`, which owns every
/// judgement made from it -- this is storage.
///
/// Both halves are plain strings, and an EMPTY `profile` is the
/// meaningful state: it means this level names only a model, to be run on
/// whatever profile the workspace already uses. That is the common case
/// on a machine with one CLI installed -- "hard cards get opus" -- and
/// making it expressible is what stops the table forcing a profile choice
/// nobody wanted to make. An empty `model` in turn means "that profile's
/// own default model".
///
/// A level with BOTH empty is not stored at all: the map's absence is
/// what "inherit" means, at both levels.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComplexityAgent {
    #[serde(default)]
    pub profile: String,
    #[serde(default)]
    pub model: String,
}

/// The app-wide half of "which agent executes this card": the `custom`
/// profile's own command and model flag, plus the complexity table.
///
/// One struct rather than three `AppConfig` fields because they are one
/// question, and because every field here is a field a save site can
/// silently wipe (see `persist_workspaces`) -- keeping them together
/// costs that argument list one positional instead of three.
///
/// Machine-local, deliberately, and for the reason `Workspace::auto_commit`
/// spells out: which CLI is installed here and which model tier this
/// human is willing to spend on a gnarly card is a fact about this
/// machine and this subscription, not about the project. The per-workspace
/// override lives on `Workspace::complexity_agents` for the same reason,
/// rather than in the repo's `.gavin-root/config.toml`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefaultsConfig {
    /// The command the `custom` profile launches when a workspace on it
    /// names none of its own. Empty means there is no app-wide custom
    /// agent, which is the shipped state.
    #[serde(default)]
    pub custom_command: String,
    /// The argv that carries a model into that command, e.g. `--model`.
    /// Empty means gavin has no way to put a model on it, and every
    /// model control for the `custom` profile stays hidden rather than
    /// guessing a flag -- the same posture the Rust profile table takes.
    #[serde(default)]
    pub custom_model_flag: String,
    /// Which agent and model each complexity level runs, keyed by the
    /// level's written name (`Complexity::as_str`). A level with no entry
    /// runs the workspace's own agent, exactly as every card did before
    /// the field existed.
    #[serde(default)]
    pub complexity: HashMap<String, ComplexityAgent>,
    /// Ordered fallback profile ids when a launch's resolved agent is
    /// over its usage-probe threshold. Empty — the shipped default — is
    /// pause-only, the behaviour every install had before this field.
    ///
    /// Lives here rather than as a thirteenth `persist_workspaces`
    /// positional because it is the same machine-local "which agent"
    /// question this struct already answers, and a new argument on that
    /// list is how a save site silently drops a setting. A workspace
    /// override lives on `Workspace::agent_fallback`; absence there
    /// inherits this chain.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_fallback: Vec<String>,
    /// Per-profile percent at which a NEW launch walks away from that
    /// agent. Missing key means 90. Distinct from the pause cycle's
    /// `limit_percent`, which still gates resume. Machine-local with the
    /// rest of this struct: the margin is about this subscription.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub fallback_thresholds: HashMap<String, u8>,
    /// App-wide overrides of shipped agent action prompts, keyed by
    /// catalog id (`action:run-task`, `builtin:commit`, …). Empty means
    /// every prompt uses its default. Lives here rather than as another
    /// `persist_workspaces` positional for the same reason
    /// `agent_fallback` does. A workspace override lives on
    /// `Workspace::action_prompt_overrides`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub action_prompt_overrides: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AppConfig {
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    /// User-assigned display names, keyed by session id. Independent of
    /// `workspaces` (a session can be renamed regardless of which
    /// page/workspace it sits in) -- callers that persist one must always
    /// carry the other's current value along too, or they'll silently
    /// reset it to empty.
    #[serde(default)]
    pub session_names: HashMap<String, String>,
    /// Open file-viewer tabs, keyed by tab id (the same opaque id space as
    /// session ids in the pane tree's `tabs` array -- a tab id appearing
    /// here means "this tab shows a file," not "this is a terminal
    /// session"). Value is the file's absolute path. Like `session_names`,
    /// this persists alongside `workspaces` and must always be carried
    /// through `persist_workspaces` rather than reconstructed, or it will
    /// silently reset to empty on the next save.
    #[serde(default)]
    pub file_tabs: HashMap<String, String>,
    /// Open per-context board tabs, keyed by tab id (same opaque id space
    /// as session/file tabs in the pane tree). Like file_tabs, persists
    /// alongside `workspaces` and must always be carried through
    /// persist_workspaces, or it silently resets to empty on save.
    #[serde(default)]
    pub board_tabs: HashMap<String, BoardTabRecord>,
    /// Open card tabs, keyed by tab id (same opaque id space as
    /// session/file/board tabs in the pane tree). Like file_tabs and
    /// board_tabs this persists alongside `workspaces` and must always be
    /// carried through persist_workspaces, or it silently resets to empty
    /// on save -- and an id in a layout tree that no tab map claims is
    /// taken to be a terminal session, so losing this map does not blank
    /// a pane, it builds a PTY for an id the daemon never had.
    #[serde(default)]
    pub card_tabs: HashMap<String, CardTabRecord>,
    /// App-global light/dark preference: "light", "dark", or absent for
    /// System -- the same "absent means default" convention as
    /// `Workspace::color`. Like session_names/file_tabs/board_tabs this
    /// must be carried through `persist_workspaces`, or it silently
    /// resets on the next save.
    #[serde(default)]
    pub theme: Option<String>,
    /// App-wide default model per agent profile id, e.g.
    /// `{"claude-code": "opus"}`. A workspace with no `[agent] model` of
    /// its own inherits the entry for the profile it runs. Keyed by
    /// profile because one string cannot serve two CLIs -- `opus` is
    /// noise to Codex, so a single field would produce a bad flag the
    /// moment a workspace switched profiles. Like
    /// session_names/file_tabs/board_tabs/theme this must be carried
    /// through `persist_workspaces`, or it silently resets on the next
    /// save.
    #[serde(default)]
    pub agent_models: HashMap<String, String>,
    /// App-wide terminal font size, in px. Absent means no one has chosen
    /// one and gavin's own default applies -- stored as absence rather
    /// than as the number, exactly like `theme`, so a later change to that
    /// default reaches every install that never expressed a preference.
    /// Like session_names/file_tabs/board_tabs/theme/agent_models it must
    /// be carried through `persist_workspaces`, or it silently resets on
    /// the next save.
    #[serde(default)]
    pub terminal_font_size: Option<u16>,
    /// App-wide default for a new card's auto-commit block. Absent means
    /// nobody has chosen and gavin's own default (off) applies -- stored
    /// as absence rather than as `false`, exactly like `theme` and
    /// `terminal_font_size`, so a later change to that default reaches
    /// every install that never expressed a preference. Like
    /// session_names/file_tabs/board_tabs/theme/agent_models/
    /// terminal_font_size it must be carried through `persist_workspaces`,
    /// or it silently resets on the next save.
    #[serde(default)]
    pub auto_commit: Option<bool>,
    /// Tombstones for workspaces removed from the sidebar, newest first.
    /// `default` so every config.json written before this field existed
    /// still loads; like session_names/file_tabs/board_tabs/theme/
    /// agent_models it must be carried through `persist_workspaces`, or
    /// it silently resets on the next save.
    #[serde(default)]
    pub removed_workspaces: Vec<RemovedWorkspace>,
    /// The app-wide agent pause cycle. `None` -- the shipped default --
    /// means no cycle at all, so no existing workspace changes behaviour
    /// on update. A workspace with no cycle of its own inherits this one.
    /// Like session_names/file_tabs/board_tabs/theme/agent_models/
    /// removed_workspaces it must be carried through `persist_workspaces`,
    /// or it silently resets on the next save.
    #[serde(default)]
    pub agent_pause: Option<AgentPauseConfig>,
    /// What the human told gavin about Superpowers, keyed by workspace
    /// root path. The seventh carry-through field.
    ///
    /// Machine-local on purpose (spec S9): a repo can travel to a machine
    /// that has no Superpowers, so an assertion made here must not vouch
    /// for a checkout somewhere else. That is also why this is not an
    /// `[agent].superpowers` key in `.gavin-root/config.toml` -- besides
    /// travelling, a new root-config key widens `SetRootConfigField`,
    /// which `min_version_for` gates by request TYPE and therefore cannot
    /// see, so it would have cost a protocol bump to store a fact that
    /// should never have left this machine.
    #[serde(default)]
    pub superpowers: HashMap<String, SuperpowersMark>,
    /// The app-wide custom agent and complexity table. The eighth
    /// carry-through field: like session_names/file_tabs/board_tabs/
    /// theme/agent_models/removed_workspaces/agent_pause/superpowers it
    /// must be carried through `persist_workspaces`, or it silently
    /// resets on the next save.
    ///
    /// One struct rather than three fields on purpose -- see
    /// `AgentDefaultsConfig`. Its type is shared with nothing else that
    /// travels beside it, so a transposed argument in that list is a
    /// compile error rather than a silently swapped value.
    #[serde(default)]
    pub agent_defaults: AgentDefaultsConfig,
    /// Whether a workspace gavin INITIALISES starts with its own files
    /// tracked by git. The ninth carry-through field: like
    /// session_names/file_tabs/board_tabs/theme/agent_models/
    /// removed_workspaces/agent_pause/superpowers/agent_defaults it must be
    /// carried through `persist_workspaces`, or it silently resets on the
    /// next save.
    ///
    /// A default and nothing more. Once a workspace exists, the answer for
    /// it lives in that repo's `.gitignore`, where git already keeps it --
    /// see `git::tracking`. Storing the per-workspace state here as well
    /// would be a second copy free to disagree with the file every other
    /// tool reads.
    #[serde(default)]
    pub git_tracking: GitTrackingDefault,
    /// The app-wide default for whether a card must be reviewed before its
    /// first Run. `None` means nobody has chosen and gavin's own default
    /// (require review) applies -- stored as absence rather than as
    /// `true`, exactly like `auto_commit`, so a later change to that
    /// default reaches every install that never expressed a preference.
    /// The tenth carry-through field: like session_names/file_tabs/
    /// board_tabs/theme/agent_models/removed_workspaces/agent_pause/
    /// superpowers/agent_defaults/git_tracking it must be carried through
    /// `persist_workspaces`, or it silently resets on the next save.
    ///
    /// Unlike `git_tracking`, this is not an initialisation-only default:
    /// a workspace with no override of its own resolves against whatever
    /// this holds at the moment of the check, so changing it here changes
    /// the answer for every inheriting workspace immediately.
    #[serde(default)]
    pub require_review: RequireReviewDefault,
    /// The app-wide launch wall. The ELEVENTH carry-through field: like
    /// session_names/file_tabs/board_tabs/theme/agent_models/
    /// removed_workspaces/agent_pause/superpowers/agent_defaults/
    /// git_tracking/require_review it must be carried through
    /// `persist_workspaces`, or it silently resets on the next save.
    ///
    /// `None` means nobody has expressed a preference and
    /// `LaunchConfig::default()` applies -- absence rather than the
    /// struct, the convention `theme` and `auto_commit` follow, so a
    /// later change to the shipped ceiling reaches every install that
    /// never touched it.
    #[serde(default)]
    pub launch: Option<LaunchConfig>,
    /// The app-wide resume flag for the `custom` agent profile (v38),
    /// e.g. `--resume`. Absent means nobody has set one and `custom`
    /// resumes not at all, the same "absence is real" convention as
    /// `terminal_font_size`/`auto_commit`. The TWELFTH carry-through
    /// field: like session_names/file_tabs/board_tabs/theme/
    /// agent_models/removed_workspaces/agent_pause/superpowers/
    /// agent_defaults/git_tracking/require_review/launch it must be
    /// carried through `persist_workspaces`, or it silently resets on
    /// the next save.
    #[serde(default)]
    pub custom_resume_args: Option<String>,
    /// The TypeSafe turn verdict's settings, including the API key.
    ///
    /// The ONE field in this struct that `persist_workspaces` does not
    /// take as an argument, and the exception is deliberate. Every other
    /// app-wide setting is mirrored in Tauri-managed state and handed
    /// back on every save, which is what the twelve warnings above are
    /// about: a save site that forgets one wipes it. This field is
    /// carried FORWARD FROM DISK instead (see `persist_workspaces`), for
    /// two reasons that point the same way.
    ///
    /// It holds a SECRET. The whole contract of the key is that it never
    /// reaches the frontend and never enters argv; keeping it out of the
    /// in-memory mirror that every window's save reads from is the same
    /// discipline one step further back. Nothing that does not need the
    /// key ever holds it.
    ///
    /// And a thirteenth positional is a real hazard on this particular
    /// function, not a theoretical one -- its own argument list carries
    /// three separate comments about same-shaped parameters being
    /// transposable without the compiler noticing. Carrying a field
    /// forward from the file cannot be transposed with anything.
    ///
    /// Written only by `typesafe.rs`'s own read-modify-write, which is
    /// also the one seam a later move to the OS keychain would touch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typesafe: Option<TypeSafeConfig>,
}

/// The TypeSafe turn verdict's two settings.
///
/// Both `Option`, on this file's usual "absence is a real answer"
/// convention: no key and never-asked are the same state here, and the
/// feature is OFF unless somebody said otherwise. That default is the
/// design rule, not a preference -- the verdict sends a session's screen
/// tail to a third party, so it cannot be something a user discovers
/// having already happened.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypeSafeConfig {
    /// Absent means off. See above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// The API key, in plaintext, in a file written 0600.
    ///
    /// NEVER serialised towards the frontend: `typesafe.rs` answers the
    /// Settings panel with a boolean saying whether one is set, and the
    /// string itself only ever travels from here into curl's stdin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// The app-wide require-review default, wrapped in a type of its own for
/// the reason `GitTrackingDefault` gives: a bare `Option<bool>` here would
/// sit beside `auto_commit` in `persist_workspaces`' argument list with
/// exactly the same shape, and the two settings are unrelated.
///
/// `None` means nobody has chosen, and gavin's own default (require
/// review, matching the security round's original always-on behaviour)
/// applies.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(transparent)]
pub struct RequireReviewDefault(pub Option<bool>);

/// The app-wide git-tracking default, wrapped in a type of its own.
///
/// A bare `Option<bool>` would sit beside `auto_commit` in
/// `persist_workspaces`' argument list with exactly the same shape, and
/// that list already carries the warning about what two same-shaped
/// positionals do when someone transposes them: nothing the compiler can
/// see. This one is a compile error instead.
///
/// `None` means nobody has chosen, and gavin's own default (tracked)
/// applies -- absence rather than `true`, the same convention `theme`,
/// `terminal_font_size` and `auto_commit` follow, so a later change to
/// that default reaches every install that never expressed a preference.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(transparent)]
pub struct GitTrackingDefault(pub Option<bool>);

/// The human's word about Superpowers for one workspace. A distinct type
/// rather than a `String` so it cannot be transposed with the three
/// same-shaped `HashMap<String, String>` fields it travels beside through
/// `persist_workspaces` -- that argument list is already long enough to
/// swap silently, and the comment there says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuperpowersMark {
    /// "I've installed it" -- taken on trust where gavin cannot check.
    Installed,
    /// "Not now". Finishes the setup step without claiming anything is
    /// installed, so declining once stops the Home banner nagging for
    /// ever (spec S6).
    Skipped,
}

pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("config.json")
}

pub fn load(config_dir: &Path) -> anyhow::Result<AppConfig> {
    let path = config_path(config_dir);
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let contents = std::fs::read_to_string(&path)?;
    // A corrupted/unparseable config file is treated the same as "no
    // saved session" rather than a startup error — a stale or missing
    // session id is already normal, expected behavior (see the
    // ListSessions check in session::bootstrap), not something that
    // should block launch.
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

pub fn save(config_dir: &Path, config: &AppConfig) -> anyhow::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_path(config_dir);
    let contents = serde_json::to_string_pretty(config)?;
    std::fs::write(&path, contents)?;
    restrict_to_owner(&path);
    Ok(())
}

/// Narrows config.json to its owner, because it now holds a credential
/// (`TypeSafeConfig::api_key`).
///
/// Unix: 0600, set after every write rather than once at creation. A file
/// that already existed keeps whatever mode it was created with, and this
/// is the only moment gavin is guaranteed to be looking at it.
///
/// Windows: nothing to do, and that is a measured answer rather than a
/// gap. The config directory is under the user's own profile
/// (`%APPDATA%\gavin`), whose inherited ACL already grants the owning
/// user, SYSTEM and Administrators and nobody else -- the same protection
/// the agent CLIs' own credential files rely on, which `agent_usage.rs`
/// reads from exactly those paths. Writing an explicit DACL here would
/// mean a new dependency to restate a rule Windows already applies.
///
/// Best-effort on purpose: a config that saved but could not be chmodded
/// is still a config that saved, and failing the write would lose the
/// user's layout over a permission bit.
fn restrict_to_owner(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::LayoutNode;

    fn sample_layout() -> LayoutNode {
        LayoutNode::Leaf {
            tabs: vec!["abc-123".to_string()],
            active_tab_index: 0,
            pinned: Vec::new(),
        }
    }

    fn sample_page() -> Page {
        Page {
            id: "page-1".to_string(),
            name: "Page 1".to_string(),
            layout: sample_layout(),
            focused_session_id: None,
            pinned_at: None,
        }
    }

    fn sample_workspace() -> Workspace {
        Workspace {
            id: "workspace-1".to_string(),
            name: "Workspace 1".to_string(),
            pages: vec![sample_page()],
            active_page_id: Some("page-1".to_string()),
            active_view: None,
            hub_view: None,
            root_path: None,
            main_session_id: None,
            orchestration_agent: None,
            developing_cards: Vec::new(),
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            confirm_tab_close: true,
            home_agent_share: None,
            git_view: None,
            last_active_at: None,
            terminal_font_size: None,
            auto_commit: None,
            auto_resume_runs: false,
            agent_pause: None,
            pinned_at: None,
            complexity_agents: HashMap::new(),
            git_tracking_asked: false,
            trusted_config_hash: None,
            mcp_foreign_servers_choice: None,
            reviewed_cards: None,
            require_review: None,
            require_review_asked: false,
            custom_resume_args: None,
            agent_fallback: None,
            armed_agents: Vec::new(),
            action_prompt_overrides: HashMap::new(),
        }
    }

    #[test]
    fn load_returns_default_when_no_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
        assert_eq!(config.workspaces, Vec::new());
    }

    #[test]
    fn theme_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig { theme: Some("light".to_string()), ..Default::default() };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap().theme, Some("light".to_string()));
    }

    #[test]
    fn absent_theme_loads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(config_path(dir.path()), r#"{"workspaces":[]}"#).unwrap();
        assert_eq!(load(dir.path()).unwrap().theme, None);
    }

    /// A pin round-trips at both levels, and a config written before the
    /// field existed loads with nothing pinned. Absence is the only
    /// correct answer for an upgrade: a stamp invented at load time
    /// would silently hoist rows the human never pinned, and every
    /// workspace would claim the same "pinned first" moment.
    #[test]
    fn pins_roundtrip_and_default_to_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.pinned_at = Some(1_700_000_000_000);
        ws.pages[0].pinned_at = Some(1_700_000_001_000);
        let config = AppConfig { workspaces: vec![ws], ..Default::default() };
        save(dir.path(), &config).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.workspaces[0].pinned_at, Some(1_700_000_000_000));
        assert_eq!(loaded.workspaces[0].pages[0].pinned_at, Some(1_700_000_001_000));

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces":[{"id":"w","name":"W","pages":[{"id":"p","name":"P","layout":{"type":"leaf","tabs":[],"activeTabIndex":0},"focusedSessionId":null}],"activePageId":null,"activeView":null}]}"#,
        )
        .unwrap();
        let old = load(dir.path()).unwrap();
        assert_eq!(old.workspaces[0].pinned_at, None);
        assert_eq!(old.workspaces[0].pages[0].pinned_at, None);
    }

    /// Workspace fallback inherit vs override, and the armed set, have to
    /// survive a round trip: a save site that dropped them would forget
    /// which CLIs this machine already set up, and reopen the wizard.
    #[test]
    fn fallback_chain_and_armed_agents_roundtrip_and_default_to_inherit() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.agent_fallback = Some(vec!["codex".to_string(), "gemini".to_string()]);
        ws.armed_agents = vec!["codex".to_string()];
        save(dir.path(), &AppConfig { workspaces: vec![ws], ..Default::default() }).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(
            loaded.workspaces[0].agent_fallback.as_deref(),
            Some(["codex".to_string(), "gemini".to_string()].as_slice())
        );
        assert_eq!(loaded.workspaces[0].armed_agents, vec!["codex".to_string()]);

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces":[{"id":"w","name":"W","pages":[{"id":"p","name":"P","layout":{"type":"leaf","tabs":[],"activeTabIndex":0},"focusedSessionId":null}],"activePageId":null,"activeView":null}]}"#,
        )
        .unwrap();
        let old = load(dir.path()).unwrap();
        assert_eq!(old.workspaces[0].agent_fallback, None);
        assert!(old.workspaces[0].armed_agents.is_empty());
        assert!(old.agent_defaults.agent_fallback.is_empty());
        assert!(old.agent_defaults.fallback_thresholds.is_empty());
    }

    #[test]
    fn agent_defaults_fallback_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.agent_defaults.agent_fallback = vec!["codex".to_string()];
        config.agent_defaults.fallback_thresholds.insert("claude-code".to_string(), 80);
        save(dir.path(), &config).unwrap();
        let loaded = load(dir.path()).unwrap().agent_defaults;
        assert_eq!(loaded.agent_fallback, vec!["codex".to_string()]);
        assert_eq!(loaded.fallback_thresholds.get("claude-code"), Some(&80));
    }

    /// Both halves of the setting round-trip, and both read as absent from
    /// a config written before they existed -- which is the whole install
    /// base on the upgrade, and the only way "inherit gavin's default"
    /// stays the starting state.
    #[test]
    fn terminal_font_sizes_roundtrip_and_default_to_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.terminal_font_size = Some(16);
        let config = AppConfig {
            workspaces: vec![ws],
            terminal_font_size: Some(11),
            ..Default::default()
        };
        save(dir.path(), &config).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.terminal_font_size, Some(11));
        assert_eq!(loaded.workspaces[0].terminal_font_size, Some(16));

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces":[{"id":"w","name":"W","pages":[],"activePageId":null,"activeView":null}]}"#,
        )
        .unwrap();
        let old = load(dir.path()).unwrap();
        assert_eq!(old.terminal_font_size, None);
        assert_eq!(old.workspaces[0].terminal_font_size, None);
    }

    /// v38: the `custom` agent profile's resume flag, exactly the same
    /// workspace-overrides-app-default-overrides-absent shape as
    /// `terminal_font_size` above -- a config.json-layer setting, not
    /// `.gavin-root/config.toml`'s `[agent]` table.
    #[test]
    fn custom_resume_args_roundtrip_override_wins_and_default_to_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.custom_resume_args = Some("--resume-ws".to_string());
        let config = AppConfig {
            workspaces: vec![ws],
            custom_resume_args: Some("--resume-app".to_string()),
            ..Default::default()
        };
        save(dir.path(), &config).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.custom_resume_args, Some("--resume-app".to_string()));
        assert_eq!(loaded.workspaces[0].custom_resume_args, Some("--resume-ws".to_string()));

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces":[{"id":"w","name":"W","pages":[],"activePageId":null,"activeView":null}]}"#,
        )
        .unwrap();
        let old = load(dir.path()).unwrap();
        assert_eq!(old.custom_resume_args, None);
        assert_eq!(old.workspaces[0].custom_resume_args, None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn session_names_roundtrip_alongside_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut session_names = HashMap::new();
        session_names.insert("abc-123".to_string(), "my project".to_string());
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names,
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(loaded.session_names.get("abc-123"), Some(&"my project".to_string()));
    }

    #[test]
    fn load_defaults_session_names_when_the_field_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [], "active_workspace_id": null}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.session_names, HashMap::new());
    }

    #[test]
    fn file_tabs_roundtrip_alongside_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut file_tabs = HashMap::new();
        file_tabs.insert("tab-1".to_string(), "/Users/alice/project/README.md".to_string());
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs,
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(
            loaded.file_tabs.get("tab-1"),
            Some(&"/Users/alice/project/README.md".to_string())
        );
    }

    #[test]
    fn load_defaults_file_tabs_when_the_field_is_absent_from_an_older_config_file() {
        let dir = tempfile::tempdir().unwrap();
        // A real config.json from before the file viewer shipped: has
        // workspaces and session_names, no file_tabs key at all.
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [], "active_workspace_id": null, "session_names": {"abc-123": "my project"}}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.file_tabs, HashMap::new());
        assert_eq!(config.session_names.get("abc-123"), Some(&"my project".to_string()));
    }

    #[test]
    fn load_defaults_workspaces_and_active_workspace_id_when_absent_from_an_older_config_file() {
        let dir = tempfile::tempdir().unwrap();
        // Mirrors a genuine config.json from before this milestone: a real
        // (non-empty) layout tree and session_names map, no workspaces key at
        // all. layout's value is irrelevant -- the field no longer exists on
        // AppConfig, so serde silently drops it -- but session_names MUST
        // survive, since it's the one piece of user data this migration is
        // required to carry forward.
        std::fs::write(
            config_path(dir.path()),
            r#"{"layout": {"type": "leaf", "tabs": ["abc-123"], "activeTabIndex": 0}, "session_names": {"abc-123": "my project"}}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces, Vec::new());
        assert_eq!(config.active_workspace_id, None);
        assert_eq!(config.session_names.get("abc-123"), Some(&"my project".to_string()));
    }

    #[test]
    fn load_defaults_a_workspaces_active_view_to_none_when_absent_from_an_older_workspace_object() {
        let dir = tempfile::tempdir().unwrap();
        // Mirrors a real pre-this-milestone Workspace object: has
        // activePageId, has no activeView key at all.
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces.len(), 1);
        assert_eq!(config.workspaces[0].active_view, None);
    }

    /// A commit run that was in flight when an OLDER build wrote the
    /// config has no `startedAt`, and a release install and a dev tree
    /// share this file -- so one of them writing the field must never
    /// stop the other loading the record. Absent reads as "not known",
    /// which the Git tab renders as no duration rather than as a
    /// fabricated one.
    #[test]
    fn load_defaults_a_commit_records_start_to_none_when_an_older_build_wrote_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [],
                "gitView": {"agentCommit": {"sessionId": "commit-1", "cwd": "/r"}}}]}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        let record = config.workspaces[0]
            .git_view
            .as_ref()
            .unwrap()
            .agent_commit
            .as_ref()
            .unwrap();
        assert_eq!(record.session_id, "commit-1");
        assert_eq!(record.started_at, None);
        assert_eq!(record.retries, 0);
    }

    #[test]
    fn workspace_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let json = serde_json::to_value(&sample_workspace()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "workspace-1",
                "name": "Workspace 1",
                "pages": [{
                    "id": "page-1",
                    "name": "Page 1",
                    "layout": { "type": "leaf", "tabs": ["abc-123"], "activeTabIndex": 0 },
                    "focusedSessionId": null
                }],
                "activePageId": "page-1",
                "activeView": null,
                "rootPath": null,
                "mainSessionId": null,
                "color": null,
                "notifyNeedsInput": true,
                "notifyFinished": true,
                "confirmTabClose": true,
                "autoResumeRuns": false,
                "gitView": null,
                "lastActiveAt": null,
                "gitTrackingAsked": false,
                "requireReviewAsked": false
            })
        );
    }

    #[test]
    fn hub_view_roundtrips_and_defaults_to_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        // The workspace is parked in a terminal, but still remembers the
        // hub tab its Hub button should reopen -- across a restart.
        ws.active_view = Some("terminal".to_string());
        ws.hub_view = Some("kanban".to_string());
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        assert_eq!(load(dir.path()).unwrap().workspaces[0].hub_view, None);
    }

    #[test]
    fn git_view_prefs_roundtrip_and_default_to_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.git_view = Some(GitViewPrefs {
            nav_width: Some(180),
            list_width: None,
            unstaged_share: Some(0.375),
            diff_layout: Some("split".to_string()),
            skip_hunk_discard_confirm: true,
            nav_collapsed: None,
            worktree: Some("/r/repo-feature".to_string()),
            graph_all: Some(false),
            agent_commit: Some(AgentCommitRecord {
                session_id: "commit-1".to_string(),
                cwd: "/r/repo-feature".to_string(),
                retries: 1,
                started_at: Some(1_757_000_000_000),
            }),
        });
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        assert_eq!(load(dir.path()).unwrap().workspaces[0].git_view, None);
    }

    #[test]
    fn home_agent_share_roundtrips_and_is_omitted_when_never_dragged() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.home_agent_share = Some(0.3125);
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);

        // Absence is the state that means "never dragged", so an
        // undragged divider must not write the key at all -- a stored
        // 0.6 would pin this install to today's shipped split forever.
        let mut plain = config.clone();
        plain.workspaces[0].home_agent_share = None;
        save(dir.path(), &plain).unwrap();
        let raw = std::fs::read_to_string(config_path(dir.path())).unwrap();
        assert!(!raw.contains("homeAgentShare"), "{raw}");
        assert_eq!(load(dir.path()).unwrap().workspaces[0].home_agent_share, None);
    }

    #[test]
    fn last_active_at_roundtrips_and_defaults_to_none_for_an_older_config() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.last_active_at = Some(1_724_500_000_000);
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);

        // A config written before the app hub: no lastActiveAt key at
        // all. It must load, not fall back to AppConfig::default() --
        // that would silently drop every workspace the user has.
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].last_active_at, None);
    }

    #[test]
    fn load_defaults_root_path_to_none_when_absent_from_an_older_workspace_object() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces[0].root_path, None);
    }

    #[test]
    fn root_path_roundtrips_through_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.root_path = Some("/Users/alice/project".to_string());
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("config-dir");
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(&nested, &config).unwrap();

        assert!(config_path(&nested).exists());
    }

    #[test]
    fn board_tabs_roundtrip_alongside_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut board_tabs = HashMap::new();
        board_tabs.insert(
            "tab-1".to_string(),
            BoardTabRecord {
                workspace_id: "ws-1".to_string(),
                context_folder: "/Users/alice/project/auth".to_string(),
            },
        );
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs,
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(loaded.board_tabs.get("tab-1").unwrap().workspace_id, "ws-1");
    }

    #[test]
    fn load_defaults_board_tabs_when_the_field_is_absent_from_an_older_config_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [], "active_workspace_id": null, "file_tabs": {"t": "/a.md"}}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.board_tabs, HashMap::new());
        assert_eq!(config.file_tabs.get("t"), Some(&"/a.md".to_string()));
    }

    #[test]
    fn card_tabs_roundtrip_and_default_empty_for_a_config_that_predates_them() {
        let dir = tempfile::tempdir().unwrap();
        let mut card_tabs = HashMap::new();
        card_tabs.insert(
            "tab-9".to_string(),
            CardTabRecord {
                workspace_id: "ws-1".to_string(),
                path: "/Users/alice/project/.gavin-root/plans/login.md".to_string(),
                view: "changes".to_string(),
                session_id: None,
            },
        );
        let config = AppConfig { card_tabs, ..AppConfig::default() };
        save(dir.path(), &config).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.card_tabs.get("tab-9").unwrap().view, "changes");

        // The whole reason the map is persisted at all: an id in a
        // layout tree that no tab map claims reads as a terminal
        // session, so a card tab that failed to come back would not go
        // missing -- it would come back as a shell.
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [], "active_workspace_id": null}"#,
        )
        .unwrap();
        assert_eq!(load(dir.path()).unwrap().card_tabs, HashMap::new());
    }

    #[test]
    fn card_tab_record_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let record = CardTabRecord {
            workspace_id: "ws-1".to_string(),
            path: "/tmp/ws/.gavin-root/plans/login.md".to_string(),
            view: "plan".to_string(),
            session_id: None,
        };
        assert_eq!(
            serde_json::to_value(&record).unwrap(),
            serde_json::json!({
                "workspaceId": "ws-1",
                "path": "/tmp/ws/.gavin-root/plans/login.md",
                "view": "plan",
            })
        );
    }

    /// The follow-up queue's tab is the one that carries a session
    /// instead of a card. Pinned separately because the two shapes have
    /// to stay distinguishable on disk: the reader picks the pane from
    /// `view`, and a queue tab that lost its `sessionId` would render a
    /// queue for no session at all.
    #[test]
    fn a_follow_up_queue_tab_carries_its_session_and_an_empty_path() {
        let record = CardTabRecord {
            workspace_id: "ws-1".to_string(),
            path: String::new(),
            view: "followups".to_string(),
            session_id: Some("sess-7".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&record).unwrap(),
            serde_json::json!({
                "workspaceId": "ws-1",
                "path": "",
                "view": "followups",
                "sessionId": "sess-7",
            })
        );
        // And a config written before the field existed still loads.
        let old: CardTabRecord = serde_json::from_value(serde_json::json!({
            "workspaceId": "ws-1",
            "path": "/tmp/ws/.gavin-root/plans/login.md",
            "view": "plan",
        }))
        .unwrap();
        assert_eq!(old.session_id, None);
    }

    #[test]
    fn board_tab_record_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let record = BoardTabRecord {
            workspace_id: "ws-1".to_string(),
            context_folder: "/tmp/ws/auth".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&record).unwrap(),
            serde_json::json!({ "workspaceId": "ws-1", "contextFolder": "/tmp/ws/auth" })
        );
    }

    /// The record survives a save/load cycle, and an old config.json that
    /// has never seen one still loads. Without the round trip the whole
    /// point is lost: a run that outlives the window is exactly the case
    /// this field exists for, and a field that does not come back is a
    /// second Generate started on top of a first.
    #[test]
    fn orchestration_agent_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.orchestration_agent = Some(OrchestrationAgentRecord {
            session_id: "session-9".to_string(),
            rail_id: Some("rail-1".to_string()),
            label: "Reorganize \u{201c}backend\u{201d}".to_string(),
        });
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }

    /// Absent is the normal state, and it must serialize away entirely --
    /// a `"orchestrationAgent": null` in every workspace would be noise in
    /// a file the human does read.
    #[test]
    fn absent_orchestration_agent_is_not_serialized() {
        let json = serde_json::to_value(sample_workspace()).unwrap();
        assert!(json.get("orchestrationAgent").is_none());
    }

    /// Same round trip for the develop records, and for a sharper reason:
    /// a develop run rewrites the card file, and the whole point of the
    /// record is that nothing else may be started on that card while it
    /// does. A record that did not survive a reload would reopen exactly
    /// the conflict it exists to close.
    #[test]
    fn developing_cards_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.developing_cards = vec![DevelopingCardRecord {
            path: "/repo/.gavin-root/plans/thin-card.md".to_string(),
            session_id: "session-4".to_string(),
        }];
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }

    /// The empty list is the normal state and serializes away entirely,
    /// the same courtesy the absent orchestration agent gets: an empty
    /// array on every workspace is noise in a file the human does read.
    #[test]
    fn empty_developing_cards_is_not_serialized() {
        let json = serde_json::to_value(sample_workspace()).unwrap();
        assert!(json.get("developingCards").is_none());
    }

    // Was main_session_and_agent_command_roundtrip: the launch command
    // moved to .gavin-root/config.toml (D41), so only the session id is
    // still a config.json concern.
    #[test]
    fn main_session_id_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.main_session_id = Some("session-1".to_string());
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }

    #[test]
    fn load_defaults_the_agent_fields_when_absent_from_an_older_workspace_object() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces[0].main_session_id, None);
        // A pre-D41 object has no agentCommand either -- nothing for the
        // migration to carry, which is the case bootstrap must tolerate.
        assert_eq!(config.workspaces[0].legacy_agent_command, None);
    }

    #[test]
    fn settings_fields_default_when_absent_from_an_older_workspace_object() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        let ws = &load(dir.path()).unwrap().workspaces[0];
        assert_eq!(ws.color, None, "absent colour means the default accent");
        assert!(ws.notify_needs_input, "notifications default on");
        assert!(ws.notify_finished, "notifications default on");
        assert!(ws.confirm_tab_close, "close confirm defaults on");
        // The one toggle that defaults the other way, because it is
        // consent rather than a habit: nothing resumes itself unless
        // this human said in advance that it may.
        assert!(!ws.auto_resume_runs, "auto-resume defaults OFF");
    }

    #[test]
    fn settings_fields_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.color = Some("#a78bfa".to_string());
        ws.notify_finished = false;
        ws.confirm_tab_close = false;
        ws.auto_resume_runs = true;
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
            card_tabs: HashMap::new(),
            theme: None,
            agent_models: HashMap::new(),
            terminal_font_size: None,
            auto_commit: None,
            removed_workspaces: Vec::new(),
            agent_pause: None,
            superpowers: HashMap::new(),
            agent_defaults: AgentDefaultsConfig::default(),
            git_tracking: GitTrackingDefault::default(),
            require_review: RequireReviewDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }

    #[test]
    fn load_treats_malformed_json_as_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(config_path(dir.path()), "{not valid json").unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
    }
}
