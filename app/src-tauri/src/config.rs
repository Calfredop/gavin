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

/// Id of the single app-wide custom profile created when migrating the
/// retired hard-coded `custom` row and its `customCommand` / `custom*`
/// fields. Stable so every `"custom"` reference can be rewritten once.
pub const MIGRATED_CUSTOM_PROFILE_ID: &str = "custom-agent";

/// The retired hard-coded profile id. Kept only so migration and a short
/// compat window can still recognise configs and launches that name it.
pub const LEGACY_CUSTOM_PROFILE_ID: &str = "custom";

/// Workspace-local custom profile ids are prefixed so they never collide
/// with an app-wide custom slug the human chose.
pub const LOCAL_PROFILE_PREFIX: &str = "local:";

/// The five stock built-in profile ids, in their shipped order. Migration
/// folds a legacy single fallback chain onto exactly these plus every
/// custom id known at the time.
pub const STOCK_PROFILE_IDS: [&str; 5] = ["claude-code", "codex", "gemini", "cursor", "opencode"];

/// Stock built-in profile ids. A custom slug must not use these; Headroom
/// and `api_family_for_daemon` treat anything else as custom-like.
pub fn is_stock_profile_id(id: &str) -> bool {
    STOCK_PROFILE_IDS.contains(&id)
}

/// One named custom agent the human defined — app-wide on
/// `AgentDefaultsConfig::custom_profiles`, or workspace-local on
/// `Workspace::custom_profiles`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomProfile {
    pub id: String,
    pub label: String,
    pub command: String,
    pub model_flag: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub effort_flag: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_args: Option<String>,
}

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

/// How the desktop reaches a workspace that lives on another machine
/// (`docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md`): the
/// ssh host -- anything `ssh <host>` accepts, an alias from
/// `~/.ssh/config` included -- and, when `gavin-daemon` is not on that
/// host's PATH, where it is. The workspace's root stays in
/// `Workspace::root_path`, as a path ON THE HOST with forward slashes.
///
/// Machine-local (D35) like `color`: how this desktop reaches the host is
/// not a fact about the project. Absent means the workspace is on this
/// machine, which is what every workspace that predates the field is.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_path: Option<String>,
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
    /// Present when the workspace lives on another machine; see
    /// `SshConfig`. Every request for this workspace then goes to that
    /// host's daemon (`remote.rs`), never to the local one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConfig>,
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
    /// Legacy single pause cycle. Deserialized so `migrate_pause_cycles`
    /// can fold it onto `pause_cycles` under every known primary; never
    /// serialized again.
    #[serde(default, skip_serializing)]
    pub agent_pause: Option<AgentPauseConfig>,
    /// This workspace's own pause cycles, keyed by PRIMARY profile id.
    /// A key absent means INHERIT the app-wide cycle for that primary,
    /// which is not the same as off — a workspace that wants no pause
    /// for a primary stores a cycle with `enabled: false` under its key.
    /// An empty map — the ordinary case — inherits every primary's
    /// cycle, and `skip_serializing_if` keeps the key out of config.json
    /// then.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub pause_cycles: HashMap<String, AgentPauseConfig>,
    /// When this workspace was pinned to the top of the sidebar, epoch
    /// milliseconds; absent means not pinned. Same rule and same reason
    /// as `Page::pinned_at`, one level up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<i64>,
    /// Legacy single complexity table (one table for every agent).
    /// Deserialized so `migrate_complexity_tables` can fold it onto
    /// `complexity_tables` under every known primary; never serialized
    /// again.
    #[serde(default, skip_serializing)]
    pub complexity_agents: HashMap<String, ComplexityAgent>,
    /// This workspace's own complexity tables, keyed by PRIMARY profile
    /// id. A key absent means INHERIT the app-wide table for that
    /// primary; a key present is that primary's whole table (a level
    /// with no entry in it still means "run the workspace's own agent").
    /// An empty map — the ordinary case — inherits every primary's
    /// table, and `skip_serializing_if` keeps the key out of config.json
    /// then.
    ///
    /// Machine-local for the same reason as `auto_commit` and
    /// `pause_cycles` (D35): which model tier this human spends on a hard
    /// card here is a habit and a subscription fact, not something to
    /// hand everyone who clones the repo.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub complexity_tables: HashMap<String, HashMap<String, ComplexityAgent>>,
    /// Extra prompt-text lines appended to prompts composed for each
    /// primary, and extra CLI arguments appended to each primary's
    /// launch command. A key absent means INHERIT the app-wide list for
    /// that primary; an empty vec under a key is an explicit "nothing
    /// extra" override for it.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub prompt_extras: HashMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub extra_cli_args: HashMap<String, Vec<String>>,
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
    /// Whether the agents gavin launches in this workspace talk to their
    /// model through Headroom (`2026-09-28-headroom-design.md`, "The
    /// switch"). Absent means inherit `AppConfig::headroom`, and failing
    /// that gavin's own default, which is OFF -- so absence is a real
    /// state, not a stand-in for `false`, and a later change to the
    /// app-wide default reaches every workspace that never chose.
    ///
    /// Per workspace because compression is a property of how a repo is
    /// run: one where it misbehaves can opt out without turning it off
    /// everywhere. Machine-local like `require_review`, for the same
    /// reason: whether THIS machine has Headroom is not a fact about
    /// the project.
    ///
    /// The daemon holds a copy of the RESOLVED answer, pushed whenever
    /// it changes (`session::set_headroom_workspaces`), because a
    /// session another agent spawns over MCP never passes through the
    /// app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headroom: Option<bool>,
    /// Whether the human has been ASKED whether this workspace requires
    /// the first-Run review. Not the answer -- `require_review` (or its
    /// absence) is that. Same shape and reason as `git_tracking_asked`:
    /// both answers are legitimate, and leaving the gate on its default is
    /// indistinguishable on disk from nobody having decided yet.
    #[serde(default)]
    pub require_review_asked: bool,
    /// Whether the human has been ASKED whether this workspace compresses
    /// its agents through Headroom -- in the setup wizard's Headroom step,
    /// or by moving the switch on the workspace's Settings tab. Not the
    /// answer -- `headroom` (or its absence) is that. Same shape and
    /// reason as `require_review_asked`: leaving compression on the
    /// app-wide default is indistinguishable on disk from nobody having
    /// decided yet.
    ///
    /// Written only once it is true, unlike the two before it: a config
    /// written by a build without the field must survive a save by this
    /// one unchanged, and every workspace in it has never been asked.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub headroom_asked: bool,
    /// Legacy resume flag for the retired hard-coded `custom` profile.
    /// Kept deserializable so migration can fold it onto a
    /// `CustomProfile::resume_args`; cleared and skipped once empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_resume_args: Option<String>,
    /// Workspace-local named custom profiles. Lives on `Workspace` in
    /// config.json (not `.gavin-root/config.toml`) to match D35
    /// machine-local agent settings (`custom_resume_args` etc.) and to
    /// avoid a protocol bump for a fact that must not travel with the
    /// repo. Ids are prefixed `local:` so they never collide with
    /// app-wide custom slugs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_profiles: Vec<CustomProfile>,
    /// Legacy single fallback chain — one list walked no matter which
    /// agent was spent. Deserialized so `migrate_fallback_chains` can fold
    /// it onto `fallback_chains` under every known primary; never
    /// serialized again.
    #[serde(default, skip_serializing)]
    pub agent_fallback: Option<Vec<String>>,
    /// This workspace's own fallback chains, keyed by PRIMARY profile id:
    /// the chain walked when that agent is the launch's resolved agent and
    /// is spent. A key absent means INHERIT the app-wide chain for that
    /// primary, which is not the same as off — a workspace that wants no
    /// fallback for a primary stores an empty vec under its key. The
    /// primary is never an element of its own chain. An empty map — the
    /// ordinary case — inherits every primary's chain, and
    /// `skip_serializing_if` keeps the key out of config.json then.
    ///
    /// Machine-local like `agent_pause`: which CLI this human spends
    /// when a subscription window is full is a fact about this machine.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub fallback_chains: HashMap<String, Vec<String>>,
    /// Profile ids this workspace has completed setup-only arming for
    /// (Integration / Superpowers / skills) without switching the active
    /// agent. The workspace's own profile is armed by init / agent-change,
    /// not this list. Empty is the ordinary case.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub armed_agents: Vec<String>,
    /// Profile ids the human answered "Don't ask again" for in that
    /// arming wizard. Never offered for arming in this workspace again,
    /// and the fallback walk skips them while they stay unarmed. Persisted
    /// because a Cancel remembered only in memory asked again on every
    /// launch of the app. Empty is the ordinary case.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub declined_agents: Vec<String>,
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
/// A level with every field empty is not stored at all: the map's absence
/// is what "inherit" means, at both levels.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComplexityAgent {
    #[serde(default)]
    pub profile: String,
    #[serde(default)]
    pub model: String,
    /// How hard this level's agent thinks -- `high`, `max`. Empty means
    /// the effort the agent would otherwise launch with. Skipped when
    /// empty, so a table that never set one is written as it was and an
    /// older build reading it back sees nothing new.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub effort: String,
}

/// The app-wide half of "which agent executes this card": named custom
/// profiles plus the complexity table.
///
/// One struct rather than scattered `AppConfig` fields because they are
/// one question, and because every field here is a field a save site can
/// silently wipe (see `persist_workspaces`) -- keeping them together
/// costs that argument list one positional instead of many.
///
/// Machine-local, deliberately, and for the reason `Workspace::auto_commit`
/// spells out: which CLI is installed here and which model tier this
/// human is willing to spend on a gnarly card is a fact about this
/// machine and this subscription, not about the project. The per-workspace
/// override lives on `Workspace::complexity_agents` for the same reason,
/// rather than in the repo's `.gavin-root/config.toml`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefaultsConfig {
    /// Named app-wide custom agent profiles. Built-ins stay in
    /// `AGENT_PROFILES`; these are user-defined rows merged at resolve
    /// time. Empty is the shipped state.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_profiles: Vec<CustomProfile>,
    /// Legacy single-custom command. Deserialized so migration can fold
    /// it into `custom_profiles`; skipped when empty after migrate.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub custom_command: String,
    /// Legacy model flag for the retired hard-coded `custom` profile.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub custom_model_flag: String,
    /// Legacy effort flag for the retired hard-coded `custom` profile.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub custom_effort_flag: String,
    /// The app-wide default effort per profile id, beside `AppConfig::
    /// agent_models`' default model -- keyed by profile for the same
    /// reason (`max` is noise to an agent that has no such level). A
    /// workspace's own `[agent] effort` wins over it. Here rather than a
    /// new `persist_workspaces` positional, like `agent_fallback`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub agent_efforts: HashMap<String, String>,
    /// Legacy API family for the retired hard-coded `custom` profile.
    /// Folded onto `CustomProfile::api_family` by migration.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub custom_api_family: String,
    /// Legacy single complexity table (one table for every agent).
    /// Deserialized so `migrate_complexity_tables` can fold it onto
    /// `complexity_tables` under every known primary; never serialized
    /// again.
    #[serde(default, skip_serializing)]
    pub complexity: HashMap<String, ComplexityAgent>,
    /// Which agent and model each complexity level runs, keyed by PRIMARY
    /// profile id and then by the level's written name
    /// (`Complexity::as_str`). A primary with no table runs the
    /// workspace's own agent at every level, exactly as every card did
    /// before complexity existed; a level with no entry in a primary's
    /// table means the same for that level.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub complexity_tables: HashMap<String, HashMap<String, ComplexityAgent>>,
    /// The app-wide pause cycles, keyed by PRIMARY profile id. A primary
    /// with no cycle is never held — the behaviour every install had
    /// before the pause existed. Lives here rather than beside
    /// `AppConfig::agent_pause` (which it replaces) so it rides the same
    /// wholesale `set_agent_defaults` save as the other per-primary
    /// maps. A workspace override lives on `Workspace::pause_cycles`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub pause_cycles: HashMap<String, AgentPauseConfig>,
    /// Extra prompt-text lines appended to prompts composed for each
    /// primary, and extra CLI arguments appended to each primary's
    /// launch command. A primary with no entry gets nothing extra. A
    /// workspace override lives on `Workspace::prompt_extras` /
    /// `Workspace::extra_cli_args`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub prompt_extras: HashMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub extra_cli_args: HashMap<String, Vec<String>>,
    /// The app-wide default agent: the profile a workspace with no
    /// `[agent] profile` of its own resolves to. Absent — the shipped
    /// state — means "claude-code", the hard-coded fallback every build
    /// before this field used, so no migration is needed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<String>,
    /// Legacy single fallback chain — one list walked no matter which
    /// agent was spent. Deserialized so `migrate_fallback_chains` can fold
    /// it onto `fallback_chains` under every known primary; never
    /// serialized again.
    #[serde(default, skip_serializing)]
    pub agent_fallback: Vec<String>,
    /// Ordered fallback profile ids when a launch's resolved agent is over
    /// its usage-probe threshold, keyed by that PRIMARY agent's profile id
    /// (the primary is never an element of its own chain). A primary with
    /// no entry is pause-only, the behaviour every install had before
    /// fallback chains existed.
    ///
    /// Lives here rather than as a thirteenth `persist_workspaces`
    /// positional because it is the same machine-local "which agent"
    /// question this struct already answers, and a new argument on that
    /// list is how a save site silently drops a setting. A workspace
    /// override lives on `Workspace::fallback_chains`; a key absent there
    /// inherits this chain for that primary.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub fallback_chains: HashMap<String, Vec<String>>,
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
    /// Legacy single app-wide pause cycle. Deserialized so
    /// `migrate_pause_cycles` can fold it onto
    /// `AgentDefaultsConfig::pause_cycles` under every known primary;
    /// never serialized again. Still carried through `persist_workspaces`
    /// positionally — always `None` once migrated.
    #[serde(default, skip_serializing)]
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
    /// The app-wide default for whether agents are compressed through
    /// Headroom. `None` means nobody has chosen and gavin's own default
    /// applies, which is OFF: installing Headroom must never quietly
    /// change how the workspaces that already exist talk to their
    /// models. The THIRTEENTH carry-through field: like session_names/
    /// file_tabs/board_tabs/theme/agent_models/removed_workspaces/
    /// agent_pause/superpowers/agent_defaults/git_tracking/
    /// require_review/launch/custom_resume_args it must be carried
    /// through `persist_workspaces`, or it silently resets on the next
    /// save.
    ///
    /// Live, like `require_review`: a workspace with no override of its
    /// own resolves against whatever this holds at the moment it is
    /// resolved, so changing it here changes the answer for every
    /// inheriting workspace at once.
    ///
    /// Skipped while unset, unlike `require_review` one field up, so a
    /// config.json nobody has touched this setting in is written back
    /// exactly as it was read.
    #[serde(default, skip_serializing_if = "HeadroomDefault::is_unset")]
    pub headroom: HeadroomDefault,
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
    /// Legacy app-wide resume flag for the retired hard-coded `custom`
    /// profile. Deserialized so migration can fold it onto
    /// `CustomProfile::resume_args`; skipped once cleared. The TWELFTH
    /// carry-through field: like session_names/file_tabs/board_tabs/
    /// theme/agent_models/removed_workspaces/agent_pause/superpowers/
    /// agent_defaults/git_tracking/require_review/launch it must be
    /// carried through `persist_workspaces`, or it silently resets on
    /// the next save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

/// The TypeSafe features' settings: the turn verdict's switch, change
/// attribution's switch, and the one key both spend.
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
    /// Change attribution's OWN switch. Absent means off, like `enabled`,
    /// and it is a separate consent: attribution sends source code (a
    /// diff excerpt per changed file) and card titles and bodies, which
    /// agreeing to send a screen tail never covered. `typesafe.rs` gates
    /// each request on the switch for its feature and never on the other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_attribution: Option<bool>,
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

/// The app-wide compression default, wrapped in a type of its own for
/// the reason `GitTrackingDefault` gives: a bare `Option<bool>` would be
/// the third of that shape in `persist_workspaces`' argument list, and
/// nothing the compiler can see would stop two of them being swapped.
///
/// `None` means nobody has chosen, and gavin's own default applies:
/// Off.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(transparent)]
pub struct HeadroomDefault(pub Option<bool>);

impl HeadroomDefault {
    /// Whether there is nothing to write. See `AppConfig::headroom`.
    pub fn is_unset(&self) -> bool {
        self.0.is_none()
    }
}

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

fn profile_id_is_legacy_custom(id: &str) -> bool {
    id.trim() == LEGACY_CUSTOM_PROFILE_ID
}

fn rewrite_profile_id(id: &mut String, replacement: &str) {
    if profile_id_is_legacy_custom(id) {
        *id = replacement.to_string();
    }
}

fn rewrite_profile_ids(ids: &mut [String], replacement: &str) {
    for id in ids {
        rewrite_profile_id(id, replacement);
    }
}

/// Whether any key or element of a per-primary chain map names the
/// retired hard-coded `custom` profile.
fn chain_map_references(map: &HashMap<String, Vec<String>>) -> bool {
    map.keys().any(|k| profile_id_is_legacy_custom(k))
        || map.values().flatten().any(|id| profile_id_is_legacy_custom(id))
}

/// The `rewrite_profile_ids` pass over a per-primary chain map: the
/// legacy id can sit in a key (the primary) as well as in a chain.
fn rewrite_chain_map_profile_ids(map: &mut HashMap<String, Vec<String>>, replacement: &str) {
    rename_map_key(map, LEGACY_CUSTOM_PROFILE_ID, replacement);
    for chain in map.values_mut() {
        rewrite_profile_ids(chain, replacement);
    }
}

/// Whether any primary key or nested entry's profile names the retired
/// hard-coded `custom` profile.
fn complexity_maps_reference(map: &HashMap<String, HashMap<String, ComplexityAgent>>) -> bool {
    map.keys().any(|k| profile_id_is_legacy_custom(k))
        || map
            .values()
            .flat_map(|t| t.values())
            .any(|a| profile_id_is_legacy_custom(&a.profile))
}

/// The same pass over per-primary complexity tables: rewrite a legacy
/// primary key and every entry's `profile`.
fn rewrite_complexity_maps_profile_ids(
    map: &mut HashMap<String, HashMap<String, ComplexityAgent>>,
    replacement: &str,
) {
    rename_map_key(map, LEGACY_CUSTOM_PROFILE_ID, replacement);
    for table in map.values_mut() {
        for entry in table.values_mut() {
            rewrite_profile_id(&mut entry.profile, replacement);
        }
    }
}

fn rename_map_key<V>(map: &mut HashMap<String, V>, from: &str, to: &str) {
    if let Some(value) = map.remove(from) {
        map.entry(to.to_string()).or_insert(value);
    }
}

fn config_toml_profile_is_custom(root: &Path) -> bool {
    let path = root.join(".gavin-root").join("config.toml");
    let Ok(existing) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(doc) = existing.parse::<toml_edit::DocumentMut>() else {
        return false;
    };
    doc.get("agent")
        .and_then(|t| t.as_table())
        .and_then(|t| t.get("profile"))
        .and_then(|v| v.as_str())
        .map(profile_id_is_legacy_custom)
        .unwrap_or(false)
}

fn rewrite_config_toml_custom_profile(root: &Path, new_id: &str) {
    let path = root.join(".gavin-root").join("config.toml");
    let Ok(existing) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut doc) = existing.parse::<toml_edit::DocumentMut>() else {
        return;
    };
    let is_custom = doc
        .get("agent")
        .and_then(|t| t.as_table())
        .and_then(|t| t.get("profile"))
        .and_then(|v| v.as_str())
        .map(profile_id_is_legacy_custom)
        .unwrap_or(false);
    if !is_custom {
        return;
    }
    doc["agent"]["profile"] = toml_edit::value(new_id);
    if let Some(t) = doc["agent"].as_table_mut() {
        t.set_implicit(false);
    }
    let _ = std::fs::write(&path, doc.to_string());
}

fn references_legacy_custom(config: &AppConfig) -> bool {
    let d = &config.agent_defaults;
    if d.complexity.values().any(|a| profile_id_is_legacy_custom(&a.profile))
        || complexity_maps_reference(&d.complexity_tables)
        || d.agent_fallback.iter().any(|id| profile_id_is_legacy_custom(id))
        || chain_map_references(&d.fallback_chains)
        || d.fallback_thresholds.contains_key(LEGACY_CUSTOM_PROFILE_ID)
        || d.agent_efforts.contains_key(LEGACY_CUSTOM_PROFILE_ID)
        || d.pause_cycles.contains_key(LEGACY_CUSTOM_PROFILE_ID)
        || d.prompt_extras.contains_key(LEGACY_CUSTOM_PROFILE_ID)
        || d.extra_cli_args.contains_key(LEGACY_CUSTOM_PROFILE_ID)
        || config.agent_models.contains_key(LEGACY_CUSTOM_PROFILE_ID)
    {
        return true;
    }
    for ws in &config.workspaces {
        if ws.complexity_agents.values().any(|a| profile_id_is_legacy_custom(&a.profile))
            || complexity_maps_reference(&ws.complexity_tables)
            || ws
                .agent_fallback
                .as_ref()
                .is_some_and(|c| c.iter().any(|id| profile_id_is_legacy_custom(id)))
            || chain_map_references(&ws.fallback_chains)
            || ws.pause_cycles.contains_key(LEGACY_CUSTOM_PROFILE_ID)
            || ws.prompt_extras.contains_key(LEGACY_CUSTOM_PROFILE_ID)
            || ws.extra_cli_args.contains_key(LEGACY_CUSTOM_PROFILE_ID)
            || ws.declined_agents.iter().any(|id| profile_id_is_legacy_custom(id))
            || ws.armed_agents.iter().any(|id| profile_id_is_legacy_custom(id))
        {
            return true;
        }
        if ws
            .root_path
            .as_deref()
            .is_some_and(|r| config_toml_profile_is_custom(Path::new(r)))
        {
            return true;
        }
    }
    false
}

fn needs_custom_migration(config: &AppConfig) -> bool {
    let d = &config.agent_defaults;
    if !d.custom_command.trim().is_empty()
        || !d.custom_model_flag.trim().is_empty()
        || !d.custom_effort_flag.trim().is_empty()
        || !d.custom_api_family.trim().is_empty()
        || config
            .custom_resume_args
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty())
    {
        return true;
    }
    if config.workspaces.iter().any(|ws| {
        ws.custom_resume_args
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty())
    }) {
        return true;
    }
    references_legacy_custom(config)
}

fn take_nonempty_option(value: &mut Option<String>) -> Option<String> {
    value.take().filter(|s| !s.trim().is_empty())
}

/// Fold the retired hard-coded `custom` profile and its `custom*` fields
/// into `custom_profiles`, rewrite every `"custom"` reference to the
/// migrated id, and clear the legacy fields. Idempotent: a second call
/// on an already-migrated config returns false and leaves it alone.
pub fn migrate_custom_profiles(config: &mut AppConfig) -> bool {
    if !needs_custom_migration(config) {
        return false;
    }

    let app_resume = take_nonempty_option(&mut config.custom_resume_args);
    if !config
        .agent_defaults
        .custom_profiles
        .iter()
        .any(|p| p.id == MIGRATED_CUSTOM_PROFILE_ID)
    {
        config.agent_defaults.custom_profiles.push(CustomProfile {
            id: MIGRATED_CUSTOM_PROFILE_ID.to_string(),
            label: "Custom".to_string(),
            command: std::mem::take(&mut config.agent_defaults.custom_command),
            model_flag: std::mem::take(&mut config.agent_defaults.custom_model_flag),
            effort_flag: std::mem::take(&mut config.agent_defaults.custom_effort_flag),
            api_family: std::mem::take(&mut config.agent_defaults.custom_api_family),
            resume_args: app_resume,
        });
    } else {
        config.agent_defaults.custom_command.clear();
        config.agent_defaults.custom_model_flag.clear();
        config.agent_defaults.custom_effort_flag.clear();
        config.agent_defaults.custom_api_family.clear();
    }

    for entry in config.agent_defaults.complexity.values_mut() {
        rewrite_profile_id(&mut entry.profile, MIGRATED_CUSTOM_PROFILE_ID);
    }
    rewrite_profile_ids(&mut config.agent_defaults.agent_fallback, MIGRATED_CUSTOM_PROFILE_ID);
    rewrite_chain_map_profile_ids(
        &mut config.agent_defaults.fallback_chains,
        MIGRATED_CUSTOM_PROFILE_ID,
    );
    rewrite_complexity_maps_profile_ids(
        &mut config.agent_defaults.complexity_tables,
        MIGRATED_CUSTOM_PROFILE_ID,
    );
    rename_map_key(
        &mut config.agent_defaults.pause_cycles,
        LEGACY_CUSTOM_PROFILE_ID,
        MIGRATED_CUSTOM_PROFILE_ID,
    );
    rename_map_key(
        &mut config.agent_defaults.prompt_extras,
        LEGACY_CUSTOM_PROFILE_ID,
        MIGRATED_CUSTOM_PROFILE_ID,
    );
    rename_map_key(
        &mut config.agent_defaults.extra_cli_args,
        LEGACY_CUSTOM_PROFILE_ID,
        MIGRATED_CUSTOM_PROFILE_ID,
    );
    rename_map_key(
        &mut config.agent_defaults.fallback_thresholds,
        LEGACY_CUSTOM_PROFILE_ID,
        MIGRATED_CUSTOM_PROFILE_ID,
    );
    rename_map_key(
        &mut config.agent_defaults.agent_efforts,
        LEGACY_CUSTOM_PROFILE_ID,
        MIGRATED_CUSTOM_PROFILE_ID,
    );
    rename_map_key(
        &mut config.agent_models,
        LEGACY_CUSTOM_PROFILE_ID,
        MIGRATED_CUSTOM_PROFILE_ID,
    );

    // Collect per-workspace decisions first so we can mutate
    // `agent_defaults` and each workspace without overlapping borrows.
    let workspace_plans: Vec<(usize, Option<String>, bool, Option<String>)> = config
        .workspaces
        .iter()
        .enumerate()
        .map(|(i, ws)| {
            let toml_was_custom = ws
                .root_path
                .as_deref()
                .is_some_and(|r| config_toml_profile_is_custom(Path::new(r)));
            let resume = ws
                .custom_resume_args
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .cloned();
            let root = ws.root_path.clone();
            (i, root, toml_was_custom, resume)
        })
        .collect();

    for (index, root, toml_was_custom, resume) in workspace_plans {
        let replacement = if toml_was_custom {
            if let Some(resume) = resume {
                let local_id = format!("{LOCAL_PROFILE_PREFIX}{MIGRATED_CUSTOM_PROFILE_ID}");
                let template = config
                    .agent_defaults
                    .custom_profiles
                    .iter()
                    .find(|p| p.id == MIGRATED_CUSTOM_PROFILE_ID)
                    .cloned()
                    .unwrap_or_else(|| CustomProfile {
                        id: MIGRATED_CUSTOM_PROFILE_ID.to_string(),
                        label: "Custom".to_string(),
                        command: String::new(),
                        model_flag: String::new(),
                        effort_flag: String::new(),
                        api_family: String::new(),
                        resume_args: None,
                    });
                let ws = &mut config.workspaces[index];
                if !ws.custom_profiles.iter().any(|p| p.id == local_id) {
                    ws.custom_profiles.push(CustomProfile {
                        id: local_id.clone(),
                        label: template.label,
                        command: template.command,
                        model_flag: template.model_flag,
                        effort_flag: template.effort_flag,
                        api_family: template.api_family,
                        resume_args: Some(resume),
                    });
                }
                local_id
            } else {
                MIGRATED_CUSTOM_PROFILE_ID.to_string()
            }
        } else {
            if let Some(resume) = resume {
                if let Some(app) = config
                    .agent_defaults
                    .custom_profiles
                    .iter_mut()
                    .find(|p| p.id == MIGRATED_CUSTOM_PROFILE_ID)
                {
                    if app.resume_args.as_ref().is_none_or(|s| s.trim().is_empty()) {
                        app.resume_args = Some(resume);
                    }
                }
            }
            MIGRATED_CUSTOM_PROFILE_ID.to_string()
        };

        let ws = &mut config.workspaces[index];
        ws.custom_resume_args = None;
        for entry in ws.complexity_agents.values_mut() {
            rewrite_profile_id(&mut entry.profile, &replacement);
        }
        if let Some(ref mut chain) = ws.agent_fallback {
            rewrite_profile_ids(chain, &replacement);
        }
        rewrite_chain_map_profile_ids(&mut ws.fallback_chains, &replacement);
        rewrite_complexity_maps_profile_ids(&mut ws.complexity_tables, &replacement);
        rename_map_key(&mut ws.pause_cycles, LEGACY_CUSTOM_PROFILE_ID, &replacement);
        rename_map_key(&mut ws.prompt_extras, LEGACY_CUSTOM_PROFILE_ID, &replacement);
        rename_map_key(&mut ws.extra_cli_args, LEGACY_CUSTOM_PROFILE_ID, &replacement);
        rewrite_profile_ids(&mut ws.declined_agents, &replacement);
        rewrite_profile_ids(&mut ws.armed_agents, &replacement);
        if let Some(root) = root.as_deref() {
            rewrite_config_toml_custom_profile(Path::new(root), &replacement);
        }
    }

    true
}

/// Fold the legacy single fallback chain — one list walked no matter
/// which agent was spent — into the per-primary maps: the old vec becomes
/// EVERY known primary's chain (the five stock ids plus every custom id
/// known at migration time), because the old model offered it for any
/// spent agent. A workspace legacy `None` means it never chose, which the
/// new model already spells as an empty map (inherit). Runs AFTER
/// `migrate_custom_profiles` so the fold carries the rewritten ids and
/// knows the migrated custom profiles. Idempotent: legacy fields are
/// cleared as they are folded, so a second call returns false.
pub fn migrate_fallback_chains(config: &mut AppConfig) -> bool {
    let mut changed = false;

    let app_custom_ids: Vec<String> = config
        .agent_defaults
        .custom_profiles
        .iter()
        .map(|p| p.id.clone())
        .collect();

    if !config.agent_defaults.agent_fallback.is_empty() {
        if config.agent_defaults.fallback_chains.is_empty() {
            let chain = std::mem::take(&mut config.agent_defaults.agent_fallback);
            for id in STOCK_PROFILE_IDS.iter().map(|s| s.to_string()).chain(app_custom_ids.iter().cloned()) {
                config.agent_defaults.fallback_chains.insert(id, chain.clone());
            }
        } else {
            // A map a newer build wrote wins; the legacy vec is dropped.
            config.agent_defaults.agent_fallback.clear();
        }
        changed = true;
    }

    for ws in &mut config.workspaces {
        let Some(chain) = ws.agent_fallback.take() else {
            continue;
        };
        if ws.fallback_chains.is_empty() {
            let ids = STOCK_PROFILE_IDS
                .iter()
                .map(|s| s.to_string())
                .chain(app_custom_ids.iter().cloned())
                .chain(ws.custom_profiles.iter().map(|p| p.id.clone()));
            for id in ids {
                ws.fallback_chains.insert(id, chain.clone());
            }
        }
        changed = true;
    }

    changed
}

/// Every primary known at migration time: the stock ids plus the
/// app-wide custom ids, and per workspace its `local:` customs.
fn known_primaries(config: &AppConfig) -> Vec<String> {
    STOCK_PROFILE_IDS
        .iter()
        .map(|s| s.to_string())
        .chain(config.agent_defaults.custom_profiles.iter().map(|p| p.id.clone()))
        .collect()
}

/// Fold the legacy single complexity table — one table consulted no
/// matter which agent a card resolved to — into the per-primary maps:
/// the old table becomes EVERY known primary's table. Runs AFTER
/// `migrate_custom_profiles` so the fold carries rewritten entry
/// profiles and knows the migrated customs. Idempotent: legacy fields
/// are cleared as they are folded, so a second call returns false.
pub fn migrate_complexity_tables(config: &mut AppConfig) -> bool {
    let mut changed = false;

    if !config.agent_defaults.complexity.is_empty() {
        if config.agent_defaults.complexity_tables.is_empty() {
            let table = std::mem::take(&mut config.agent_defaults.complexity);
            for id in known_primaries(config) {
                config.agent_defaults.complexity_tables.insert(id, table.clone());
            }
        } else {
            config.agent_defaults.complexity.clear();
        }
        changed = true;
    }

    let app_custom_ids: Vec<String> = config
        .agent_defaults
        .custom_profiles
        .iter()
        .map(|p| p.id.clone())
        .collect();
    for ws in &mut config.workspaces {
        if ws.complexity_agents.is_empty() {
            continue;
        }
        if ws.complexity_tables.is_empty() {
            let table = std::mem::take(&mut ws.complexity_agents);
            let ids = STOCK_PROFILE_IDS
                .iter()
                .map(|s| s.to_string())
                .chain(app_custom_ids.iter().cloned())
                .chain(ws.custom_profiles.iter().map(|p| p.id.clone()));
            for id in ids {
                ws.complexity_tables.insert(id, table.clone());
            }
        } else {
            ws.complexity_agents.clear();
        }
        changed = true;
    }

    changed
}

/// Fold the legacy single pause cycle — one cycle for every agent — into
/// the per-primary maps: the old cycle becomes EVERY known primary's
/// cycle, because the old model applied it to any launch. A workspace
/// legacy `None` means it never chose, which the new model already
/// spells as an empty map (inherit). Idempotent: legacy fields are
/// cleared as they are folded, so a second call returns false.
pub fn migrate_pause_cycles(config: &mut AppConfig) -> bool {
    let mut changed = false;

    if let Some(cycle) = config.agent_pause.take() {
        if config.agent_defaults.pause_cycles.is_empty() {
            for id in known_primaries(config) {
                config.agent_defaults.pause_cycles.insert(id, cycle.clone());
            }
        }
        changed = true;
    }

    let app_custom_ids: Vec<String> = config
        .agent_defaults
        .custom_profiles
        .iter()
        .map(|p| p.id.clone())
        .collect();
    for ws in &mut config.workspaces {
        let Some(cycle) = ws.agent_pause.take() else {
            continue;
        };
        if ws.pause_cycles.is_empty() {
            let ids = STOCK_PROFILE_IDS
                .iter()
                .map(|s| s.to_string())
                .chain(app_custom_ids.iter().cloned())
                .chain(ws.custom_profiles.iter().map(|p| p.id.clone()));
            for id in ids {
                ws.pause_cycles.insert(id, cycle.clone());
            }
        }
        changed = true;
    }

    changed
}

/// Look up the API family a launch should send for `profile_id`: the
/// matching custom profile's, else the legacy `custom_api_family` while
/// a config still names `"custom"`.
pub fn api_family_for_profile(
    defaults: &AgentDefaultsConfig,
    workspace_customs: &[CustomProfile],
    profile_id: Option<&str>,
) -> Option<String> {
    let id = profile_id.map(str::trim).filter(|s| !s.is_empty())?;
    if let Some(profile) = workspace_customs.iter().find(|p| p.id == id) {
        let family = profile.api_family.trim();
        return (!family.is_empty()).then(|| family.to_string());
    }
    if let Some(profile) = defaults.custom_profiles.iter().find(|p| p.id == id) {
        let family = profile.api_family.trim();
        return (!family.is_empty()).then(|| family.to_string());
    }
    if profile_id_is_legacy_custom(id) {
        let family = defaults.custom_api_family.trim();
        return (!family.is_empty()).then(|| family.to_string());
    }
    None
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
    let mut config: AppConfig = serde_json::from_str(&contents).unwrap_or_default();
    // `|` rather than `||`: both passes must run even when the first one
    // already changed something (the fallback fold needs the custom
    // migration's rewritten ids).
    if migrate_custom_profiles(&mut config)
        | migrate_fallback_chains(&mut config)
        | migrate_complexity_tables(&mut config)
        | migrate_pause_cycles(&mut config)
    {
        // Persist so a second load is a no-op and legacy keys leave the
        // file; a failed write still returns the migrated in-memory shape.
        let _ = save(config_dir, &config);
    }
    Ok(config)
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
            pause_cycles: HashMap::new(),
            prompt_extras: HashMap::new(),
            extra_cli_args: HashMap::new(),
            pinned_at: None,
            complexity_agents: HashMap::new(),
            complexity_tables: HashMap::new(),
            git_tracking_asked: false,
            trusted_config_hash: None,
            mcp_foreign_servers_choice: None,
            reviewed_cards: None,
            require_review: None,
            headroom: None,
            require_review_asked: false,
            headroom_asked: false,
            custom_resume_args: None,
            custom_profiles: Vec::new(),
            agent_fallback: None,
            fallback_chains: HashMap::new(),
            armed_agents: Vec::new(),
            declined_agents: Vec::new(),
            ssh: None,
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
        ws.fallback_chains = HashMap::from([(
            "claude-code".to_string(),
            vec!["codex".to_string(), "gemini".to_string()],
        )]);
        ws.armed_agents = vec!["codex".to_string()];
        ws.declined_agents = vec!["gemini".to_string()];
        save(dir.path(), &AppConfig { workspaces: vec![ws], ..Default::default() }).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(
            loaded.workspaces[0].fallback_chains.get("claude-code"),
            Some(&vec!["codex".to_string(), "gemini".to_string()])
        );
        assert_eq!(loaded.workspaces[0].armed_agents, vec!["codex".to_string()]);
        assert_eq!(loaded.workspaces[0].declined_agents, vec!["gemini".to_string()]);

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces":[{"id":"w","name":"W","pages":[{"id":"p","name":"P","layout":{"type":"leaf","tabs":[],"activeTabIndex":0},"focusedSessionId":null}],"activePageId":null,"activeView":null}]}"#,
        )
        .unwrap();
        let old = load(dir.path()).unwrap();
        assert!(old.workspaces[0].fallback_chains.is_empty());
        assert!(old.workspaces[0].armed_agents.is_empty());
        assert!(old.workspaces[0].declined_agents.is_empty());
        assert!(old.agent_defaults.agent_fallback.is_empty());
        assert!(old.agent_defaults.fallback_chains.is_empty());
        assert!(old.agent_defaults.fallback_thresholds.is_empty());
    }

    /// Named custom profiles persist, and a config that never defined
    /// any -- every config written before they existed -- reads as empty.
    #[test]
    fn custom_profiles_roundtrip_and_default_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.agent_defaults.custom_profiles.push(CustomProfile {
            id: "my-bot".to_string(),
            label: "My Bot".to_string(),
            command: "my-agent".to_string(),
            model_flag: "--llm".to_string(),
            effort_flag: "--think=".to_string(),
            api_family: "openai".to_string(),
            resume_args: Some("--resume".to_string()),
        });
        let mut ws = sample_workspace();
        ws.custom_profiles.push(CustomProfile {
            id: "local:ws-bot".to_string(),
            label: "WS Bot".to_string(),
            command: "ws-agent".to_string(),
            model_flag: "-m".to_string(),
            effort_flag: String::new(),
            api_family: String::new(),
            resume_args: None,
        });
        config.workspaces.push(ws);
        save(dir.path(), &config).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.agent_defaults.custom_profiles.len(), 1);
        assert_eq!(loaded.agent_defaults.custom_profiles[0].id, "my-bot");
        assert_eq!(loaded.agent_defaults.custom_profiles[0].api_family, "openai");
        assert_eq!(loaded.workspaces[0].custom_profiles[0].id, "local:ws-bot");

        config.agent_defaults.custom_profiles.clear();
        config.workspaces[0].custom_profiles.clear();
        save(dir.path(), &config).unwrap();
        let written = std::fs::read_to_string(config_path(dir.path())).unwrap();
        assert!(!written.contains("customProfiles"), "{written}");
    }

    /// The retired hard-coded `custom` row and its `custom*` fields fold
    /// into one app-wide `custom-agent` profile; a second load is a no-op.
    #[test]
    fn migrates_legacy_custom_fields_once_and_rewrites_refs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join(".gavin-root")).unwrap();
        std::fs::write(
            root.join(".gavin-root").join("config.toml"),
            "[agent]\nprofile = \"custom\"\nfile = \"RULES.md\"\n",
        )
        .unwrap();

        // AppConfig fields are snake_case; nested Workspace / AgentDefaults
        // are camelCase — match what an older build wrote to disk.
        let raw = r#"{
  "workspaces": [{
    "id": "workspace-1",
    "name": "Workspace 1",
    "pages": [{"id":"page-1","name":"Page 1","layout":{"type":"leaf","tabs":["abc-123"],"activeTabIndex":0},"focusedSessionId":null}],
    "activePageId": "page-1",
    "activeView": null,
    "rootPath": "ROOT",
    "complexityAgents": {"complex": {"profile": "custom", "model": "big"}},
    "agentFallback": ["custom", "codex"],
    "armedAgents": ["custom"],
    "declinedAgents": ["custom"],
    "customResumeArgs": "--resume-ws"
  }],
  "custom_resume_args": "--resume-app",
  "agent_models": {"custom": "big-model"},
  "agent_defaults": {
    "customCommand": "my-agent",
    "customModelFlag": "--llm",
    "customEffortFlag": "--think=",
    "customApiFamily": "anthropic",
    "complexity": {"intricate": {"profile": "custom", "model": "x"}},
    "agentFallback": ["custom", "gemini"],
    "fallbackThresholds": {"custom": 80},
    "agentEfforts": {"custom": "high"}
  }
}"#
        .replace("ROOT", &root.to_string_lossy());
        std::fs::write(config_path(dir.path()), raw).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.agent_defaults.custom_profiles.len(), 1);
        let profile = &loaded.agent_defaults.custom_profiles[0];
        assert_eq!(profile.id, MIGRATED_CUSTOM_PROFILE_ID);
        assert_eq!(profile.label, "Custom");
        assert_eq!(profile.command, "my-agent");
        assert_eq!(profile.model_flag, "--llm");
        assert_eq!(profile.effort_flag, "--think=");
        assert_eq!(profile.api_family, "anthropic");
        assert_eq!(profile.resume_args.as_deref(), Some("--resume-app"));
        assert!(loaded.custom_resume_args.is_none());
        assert!(loaded.agent_defaults.custom_command.is_empty());
        assert!(loaded.agent_defaults.custom_model_flag.is_empty());
        assert!(loaded.agent_defaults.custom_effort_flag.is_empty());
        assert!(loaded.agent_defaults.custom_api_family.is_empty());
        // The legacy complexity table was rewritten, then folded onto
        // every known primary by `migrate_complexity_tables`.
        assert!(loaded.agent_defaults.complexity.is_empty());
        assert_eq!(
            loaded.agent_defaults.complexity_tables["claude-code"]["intricate"].profile,
            MIGRATED_CUSTOM_PROFILE_ID
        );
        // The legacy single chain was rewritten, then folded onto every
        // known primary (the five stock ids plus the migrated custom one)
        // by `migrate_fallback_chains`.
        assert!(loaded.agent_defaults.agent_fallback.is_empty());
        let expected_chain = vec![MIGRATED_CUSTOM_PROFILE_ID.to_string(), "gemini".to_string()];
        for id in STOCK_PROFILE_IDS.iter().chain([MIGRATED_CUSTOM_PROFILE_ID].iter()) {
            assert_eq!(
                loaded.agent_defaults.fallback_chains.get(*id),
                Some(&expected_chain),
                "app chain for {id}"
            );
        }
        assert!(loaded
            .agent_defaults
            .fallback_thresholds
            .contains_key(MIGRATED_CUSTOM_PROFILE_ID));
        assert!(!loaded
            .agent_defaults
            .fallback_thresholds
            .contains_key(LEGACY_CUSTOM_PROFILE_ID));
        assert_eq!(
            loaded.agent_models.get(MIGRATED_CUSTOM_PROFILE_ID).map(String::as_str),
            Some("big-model")
        );

        let local_id = format!("{LOCAL_PROFILE_PREFIX}{MIGRATED_CUSTOM_PROFILE_ID}");
        assert_eq!(loaded.workspaces[0].custom_profiles.len(), 1);
        assert_eq!(loaded.workspaces[0].custom_profiles[0].id, local_id);
        assert_eq!(
            loaded.workspaces[0].custom_profiles[0].resume_args.as_deref(),
            Some("--resume-ws")
        );
        assert!(loaded.workspaces[0].custom_resume_args.is_none());
        // The workspace's legacy complexity table folded onto every known
        // primary, rewritten to the local profile id first.
        assert!(loaded.workspaces[0].complexity_agents.is_empty());
        assert_eq!(
            loaded.workspaces[0].complexity_tables["claude-code"]["complex"].profile,
            local_id
        );
        // The workspace's legacy chain folded onto every known primary:
        // stock, the app-wide custom, and this workspace's new local.
        assert!(loaded.workspaces[0].agent_fallback.is_none());
        let expected_ws_chain = vec![local_id.clone(), "codex".to_string()];
        for id in STOCK_PROFILE_IDS
            .iter()
            .chain([MIGRATED_CUSTOM_PROFILE_ID, local_id.as_str()].iter())
        {
            assert_eq!(
                loaded.workspaces[0].fallback_chains.get(*id),
                Some(&expected_ws_chain),
                "workspace chain for {id}"
            );
        }
        assert_eq!(loaded.workspaces[0].armed_agents, vec![local_id.clone()]);
        assert_eq!(loaded.workspaces[0].declined_agents, vec![local_id.clone()]);
        let toml = std::fs::read_to_string(root.join(".gavin-root").join("config.toml")).unwrap();
        assert!(toml.contains(&format!("profile = \"{local_id}\"")), "{toml}");
        assert!(!toml.contains("profile = \"custom\""));

        // Second load is a no-op: no legacy fields, no `"custom"` refs.
        let again = load(dir.path()).unwrap();
        assert_eq!(again, loaded);
        let mut again_mut = again.clone();
        assert!(!migrate_custom_profiles(&mut again_mut));
        let written = std::fs::read_to_string(config_path(dir.path())).unwrap();
        assert!(!written.contains("customCommand"), "{written}");
        assert!(!written.contains("\"custom\""), "{written}");
    }

    /// The custom agent's API family persists on a CustomProfile, and a
    /// config that never chose one reads as none.
    #[test]
    fn the_custom_api_family_roundtrips_and_defaults_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.agent_defaults.custom_profiles.push(CustomProfile {
            id: "my-bot".to_string(),
            label: "My Bot".to_string(),
            command: "my-agent".to_string(),
            model_flag: "--model".to_string(),
            effort_flag: String::new(),
            api_family: "anthropic".to_string(),
            resume_args: None,
        });
        save(dir.path(), &config).unwrap();
        assert_eq!(
            load(dir.path()).unwrap().agent_defaults.custom_profiles[0].api_family,
            "anthropic"
        );

        config.agent_defaults.custom_profiles[0].api_family.clear();
        save(dir.path(), &config).unwrap();
        let written = std::fs::read_to_string(config_path(dir.path())).unwrap();
        assert!(!written.contains("apiFamily"), "{written}");

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces":[],"agent_defaults":{"complexity":{}}}"#,
        )
        .unwrap();
        assert!(load(dir.path()).unwrap().agent_defaults.custom_profiles.is_empty());
    }

    /// Resume args live on the CustomProfile after migration; an already-
    /// migrated config round-trips without resurrecting the legacy keys.
    #[test]
    fn custom_resume_args_roundtrip_override_wins_and_default_to_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.custom_profiles.push(CustomProfile {
            id: format!("{LOCAL_PROFILE_PREFIX}{MIGRATED_CUSTOM_PROFILE_ID}"),
            label: "Custom".to_string(),
            command: "my-agent".to_string(),
            model_flag: String::new(),
            effort_flag: String::new(),
            api_family: String::new(),
            resume_args: Some("--resume-ws".to_string()),
        });
        let mut config = AppConfig {
            workspaces: vec![ws],
            ..Default::default()
        };
        config.agent_defaults.custom_profiles.push(CustomProfile {
            id: MIGRATED_CUSTOM_PROFILE_ID.to_string(),
            label: "Custom".to_string(),
            command: "my-agent".to_string(),
            model_flag: String::new(),
            effort_flag: String::new(),
            api_family: String::new(),
            resume_args: Some("--resume-app".to_string()),
        });
        save(dir.path(), &config).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(
            loaded.agent_defaults.custom_profiles[0].resume_args.as_deref(),
            Some("--resume-app")
        );
        assert_eq!(
            loaded.workspaces[0].custom_profiles[0].resume_args.as_deref(),
            Some("--resume-ws")
        );
        assert!(loaded.custom_resume_args.is_none());
        assert!(loaded.workspaces[0].custom_resume_args.is_none());

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces":[{"id":"w","name":"W","pages":[],"activePageId":null,"activeView":null}]}"#,
        )
        .unwrap();
        let old = load(dir.path()).unwrap();
        assert_eq!(old.custom_resume_args, None);
        assert_eq!(old.workspaces[0].custom_resume_args, None);
        assert!(old.agent_defaults.custom_profiles.is_empty());
    }

    /// Every effort field round-trips, and a config written before any of
    /// them existed -- a complexity row with only a profile and a model --
    /// reads back as no effort anywhere. Empty is written as no key, so a
    /// config that never chose an effort is byte-for-byte what it was.
    #[test]
    fn agent_efforts_roundtrip_and_default_to_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.agent_defaults.custom_profiles.push(CustomProfile {
            id: "my-bot".to_string(),
            label: "My Bot".to_string(),
            command: "my-agent".to_string(),
            model_flag: String::new(),
            effort_flag: "--think=".to_string(),
            api_family: String::new(),
            resume_args: None,
        });
        config.agent_defaults.agent_efforts.insert("claude-code".to_string(), "high".to_string());
        config.agent_defaults.complexity_tables.insert(
            "claude-code".to_string(),
            HashMap::from([(
                "intricate".to_string(),
                ComplexityAgent { profile: String::new(), model: "opus".to_string(), effort: "max".to_string() },
            )]),
        );
        save(dir.path(), &config).unwrap();
        let loaded = load(dir.path()).unwrap().agent_defaults;
        assert_eq!(loaded.custom_profiles[0].effort_flag, "--think=");
        assert_eq!(loaded.agent_efforts.get("claude-code").map(String::as_str), Some("high"));
        assert_eq!(loaded.complexity_tables["claude-code"]["intricate"].effort, "max");

        config.agent_defaults = AgentDefaultsConfig::default();
        config.agent_defaults.complexity_tables.insert(
            "claude-code".to_string(),
            HashMap::from([(
                "simple".to_string(),
                ComplexityAgent { profile: String::new(), model: "haiku".to_string(), effort: String::new() },
            )]),
        );
        save(dir.path(), &config).unwrap();
        let written = std::fs::read_to_string(config_path(dir.path())).unwrap();
        for key in ["customEffortFlag", "agentEfforts", "effort", "effortFlag"] {
            assert!(!written.contains(key), "{key} written while empty: {written}");
        }

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces":[],"agent_defaults":{"complexity":{"complex":{"profile":"codex","model":"gpt-5.1"}}}}"#,
        )
        .unwrap();
        // A config written before per-primary tables folds the legacy
        // `complexity` map onto every known primary.
        let old = load(dir.path()).unwrap().agent_defaults;
        assert!(old.complexity.is_empty());
        assert_eq!(old.complexity_tables["claude-code"]["complex"].effort, "");
        assert_eq!(old.complexity_tables["codex"]["complex"].model, "gpt-5.1");
        assert!(old.agent_efforts.is_empty());
        assert!(old.custom_profiles.is_empty());
    }

    #[test]
    fn agent_defaults_fallback_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config
            .agent_defaults
            .fallback_chains
            .insert("claude-code".to_string(), vec!["codex".to_string()]);
        config.agent_defaults.fallback_thresholds.insert("claude-code".to_string(), 80);
        save(dir.path(), &config).unwrap();
        let loaded = load(dir.path()).unwrap().agent_defaults;
        assert_eq!(
            loaded.fallback_chains.get("claude-code"),
            Some(&vec!["codex".to_string()])
        );
        assert!(loaded.agent_fallback.is_empty());
        assert_eq!(loaded.fallback_thresholds.get("claude-code"), Some(&80));
    }

    /// The app-wide default agent round-trips, and a config written before
    /// the field existed reads as absent — which the frontend resolves to
    /// "claude-code", the hard-coded fallback every older build used.
    #[test]
    fn default_agent_roundtrips_and_defaults_to_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.agent_defaults.default_agent = Some("codex".to_string());
        save(dir.path(), &config).unwrap();
        assert_eq!(
            load(dir.path()).unwrap().agent_defaults.default_agent.as_deref(),
            Some("codex")
        );

        std::fs::write(config_path(dir.path()), r#"{"workspaces":[],"agent_defaults":{"complexity":{}}}"#).unwrap();
        assert_eq!(load(dir.path()).unwrap().agent_defaults.default_agent, None);
    }

    /// The legacy single fallback chain — one list for every agent —
    /// folds onto every known primary at both levels, once; a workspace
    /// that never chose inherits (empty map), and a second load is a
    /// no-op.
    #[test]
    fn migrates_legacy_fallback_chains_once_and_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r#"{
  "workspaces": [
    {
      "id": "with-chain",
      "name": "With Chain",
      "pages": [],
      "activePageId": null,
      "activeView": null,
      "agentFallback": ["codex", "gemini"],
      "customProfiles": [{"id": "local:bot", "label": "Bot", "command": "bot", "modelFlag": ""}]
    },
    {
      "id": "inheriting",
      "name": "Inheriting",
      "pages": [],
      "activePageId": null,
      "activeView": null
    }
  ],
  "agent_defaults": {
    "complexity": {},
    "agentFallback": ["codex"],
    "customProfiles": [{"id": "my-bot", "label": "My Bot", "command": "mb", "modelFlag": ""}]
  }
}"#;
        std::fs::write(config_path(dir.path()), raw).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert!(loaded.agent_defaults.agent_fallback.is_empty());
        for id in STOCK_PROFILE_IDS.iter().chain(["my-bot"].iter()) {
            assert_eq!(
                loaded.agent_defaults.fallback_chains.get(*id),
                Some(&vec!["codex".to_string()]),
                "app chain for {id}"
            );
        }
        let ws = &loaded.workspaces[0];
        assert!(ws.agent_fallback.is_none());
        for id in STOCK_PROFILE_IDS.iter().chain(["my-bot", "local:bot"].iter()) {
            assert_eq!(
                ws.fallback_chains.get(*id),
                Some(&vec!["codex".to_string(), "gemini".to_string()]),
                "workspace chain for {id}"
            );
        }
        // Legacy None: never chose, so an empty map — inherit.
        assert!(loaded.workspaces[1].fallback_chains.is_empty());

        // The file no longer carries the legacy key, and a second load is
        // a no-op.
        let written = std::fs::read_to_string(config_path(dir.path())).unwrap();
        assert!(!written.contains("agentFallback"), "{written}");
        assert!(written.contains("fallbackChains"), "{written}");
        let again = load(dir.path()).unwrap();
        assert_eq!(again, loaded);
        let mut again_mut = again.clone();
        assert!(!migrate_fallback_chains(&mut again_mut));
    }

    /// The legacy single complexity table and pause cycle fold onto every
    /// known primary at both levels, once; legacy keys leave the file and
    /// a second load is a no-op. The new prompt-param maps need no
    /// migration: they have no legacy shape.
    #[test]
    fn migrates_legacy_complexity_and_pause_once_and_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r#"{
  "workspaces": [{
    "id": "w",
    "name": "W",
    "pages": [],
    "activePageId": null,
    "activeView": null,
    "agentPause": { "enabled": true, "periodMinutes": 300, "pauseMinutes": 10, "anchorMs": 7, "limitPercent": 90.0, "limitEnabled": true },
    "complexityAgents": { "complex": { "profile": "codex", "model": "gpt" } },
    "customProfiles": [{"id": "local:bot", "label": "Bot", "command": "bot", "modelFlag": ""}]
  }],
  "agent_pause": { "enabled": true, "periodMinutes": 240, "pauseMinutes": 5, "anchorMs": 3, "limitPercent": 95.0, "limitEnabled": false },
  "agent_defaults": {
    "complexity": { "intricate": { "profile": "claude-code", "model": "opus" } },
    "customProfiles": [{"id": "my-bot", "label": "My Bot", "command": "mb", "modelFlag": ""}]
  }
}"#;
        std::fs::write(config_path(dir.path()), raw).unwrap();

        let loaded = load(dir.path()).unwrap();
        for id in STOCK_PROFILE_IDS.iter().chain(["my-bot"].iter()) {
            assert_eq!(
                loaded.agent_defaults.complexity_tables[*id]["intricate"].model,
                "opus",
                "app complexity table for {id}"
            );
            let cycle = &loaded.agent_defaults.pause_cycles[*id];
            assert_eq!((cycle.period_minutes, cycle.anchor_ms), (240, 3), "app cycle for {id}");
        }
        assert!(loaded.agent_defaults.complexity.is_empty());
        assert!(loaded.agent_pause.is_none());

        let ws = &loaded.workspaces[0];
        for id in STOCK_PROFILE_IDS.iter().chain(["my-bot", "local:bot"].iter()) {
            assert_eq!(ws.complexity_tables[*id]["complex"].profile, "codex", "ws table for {id}");
            let cycle = &ws.pause_cycles[*id];
            assert_eq!((cycle.pause_minutes, cycle.limit_percent), (10, 90.0), "ws cycle for {id}");
        }
        assert!(ws.complexity_agents.is_empty());
        assert!(ws.agent_pause.is_none());

        let written = std::fs::read_to_string(config_path(dir.path())).unwrap();
        assert!(!written.contains("complexityAgents"), "{written}");
        assert!(!written.contains("agentPause"), "{written}");
        assert!(!written.contains("agent_pause"), "{written}");
        assert!(written.contains("complexityTables"), "{written}");
        assert!(written.contains("pauseCycles"), "{written}");
        let again = load(dir.path()).unwrap();
        assert_eq!(again, loaded);
        let mut again_mut = again.clone();
        assert!(!migrate_complexity_tables(&mut again_mut));
        assert!(!migrate_pause_cycles(&mut again_mut));
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

    /// v38 legacy keys are gone after migration; resume lives on the
    /// CustomProfile. Covered by `custom_resume_args_roundtrip_override_wins_and_default_to_absent`
    /// above (the CustomProfile form) and `migrates_legacy_custom_fields_once_and_rewrites_refs`.

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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
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
            headroom: HeadroomDefault::default(),
            launch: None,
            custom_resume_args: None,
            typesafe: None,
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }

    /// An ssh workspace names the host the desktop reaches its daemon
    /// through, and optionally where the daemon binary is there. The
    /// workspace's root stays in `root_path`, as a path ON THE HOST.
    #[test]
    fn ssh_roundtrips_in_the_camel_case_shape_the_frontend_expects() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.root_path = Some("/home/me/repo".to_string());
        ws.ssh = Some(SshConfig {
            host: "box".to_string(),
            daemon_path: Some("/opt/gavin/gavin-daemon".to_string()),
        });
        let value = serde_json::to_value(&ws).unwrap();
        assert_eq!(value["ssh"]["host"], "box");
        assert_eq!(value["ssh"]["daemonPath"], "/opt/gavin/gavin-daemon");
        let config = AppConfig { workspaces: vec![ws], ..AppConfig::default() };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }

    /// A local workspace -- every workspace there has ever been -- writes
    /// no `ssh` key at all, and one saved before the field loads as local.
    #[test]
    fn ssh_is_absent_for_a_local_workspace_and_defaults_to_absent() {
        let value = serde_json::to_value(&sample_workspace()).unwrap();
        assert!(value.get("ssh").is_none(), "{value}");
        let default_path =
            serde_json::to_value(&SshConfig { host: "box".to_string(), daemon_path: None }).unwrap();
        assert!(default_path.get("daemonPath").is_none(), "{default_path}");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        assert_eq!(load(dir.path()).unwrap().workspaces[0].ssh, None);
    }

    #[test]
    fn load_treats_malformed_json_as_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(config_path(dir.path()), "{not valid json").unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
    }
}
