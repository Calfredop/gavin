// TypeScript mirrors of crates/protocol's gavin tree shapes (camelCase on
// the wire via serde, verified by the protocol crate's shape tests).

import type { Complexity } from "$lib/complexity";

export interface PlanFileInfo {
  path: string;
  fileName: string;
  title: string;
  status: string | null;
  priority: "none" | "low" | "medium" | "high" | "urgent" | null;
  order: number | null;
  kind: "note" | "task" | "plan";
  parent: string | null;
  labels: string[];
  checklistDone: number;
  checklistTotal: number;
  parseWarning: boolean;
  // The card file's mtime, in whole seconds since the unix epoch. The
  // archive grid orders by it. Optional so fixtures and older daemons
  // (which never send it) stay valid -- absent sorts last.
  modifiedAt?: number | null;
  // The card's `attachments:` line, split on commas and trimmed: files
  // the card points an agent at, relative to the workspace root or
  // absolute. RAW, so a path that no longer resolves reaches the UI as a
  // broken chip instead of vanishing. Optional for the same reason
  // `modifiedAt` is -- fixtures, and a pre-v18 daemon never sends it.
  attachments?: string[];
  // The card's `complexity:` line -- how hard the work is -- or null
  // where the card says nothing, which is a different answer from
  // "trivial": it means the card runs the workspace's own agent.
  // Optional for the same reason `attachments` is, and additionally
  // because a pre-v31 daemon never sends it.
  complexity?: Complexity | null;
  // The card's `agent:` and `model:` lines -- the profile and model THIS
  // card runs on, whatever its complexity level or the workspace would
  // otherwise pick. RAW, like `attachments` and unlike `complexity`: the
  // daemon has no profile table to check a name against, so a value the
  // app cannot resolve reads back as itself and the typo is visible.
  // Optional for the same reasons as the fields above, and additionally
  // because a pre-v32 daemon never sends either.
  agent?: string | null;
  model?: string | null;
}

export interface MdFileInfo {
  path: string;
  relPath: string;
}

export interface AgentConfig {
  profile: string | null;
  file: string | null;
  command: string | null;
  /// The `custom` profile's MCP config path and dialect; the five stock
  /// profiles carry a verified layout in the Rust table instead. Optional
  /// because an older daemon's tree does not send them.
  mcpFile?: string | null;
  mcpFormat?: string | null;
  /// The workspace's chosen model. Optional because an older daemon does
  /// not send it; absent means the app-wide default for this profile
  /// applies instead.
  model?: string | null;
  /// The argv that carries `model` into this workspace's agent. Absent
  /// means the profile table's own flag applies, which is the right
  /// answer for the five stock profiles; it exists for `custom`, whose
  /// binary the table cannot know. Optional because a pre-v31 daemon
  /// never sends it.
  modelFlag?: string | null;
}

export interface GavinContext {
  folderPath: string;
  kind: "root" | "context";
  name: string;
  plans: PlanFileInfo[];
  docs: MdFileInfo[];
  specs: MdFileInfo[];
  hasPrd: boolean;
  configWarning: boolean;
  agent?: AgentConfig | null;
  /// The root config's top-level `prd`, when it names a usable relative
  /// path — the lead document this workspace points at. Optional because
  /// a pre-v17 daemon does not send it; absent means the scaffolded
  /// DEFAULT_PRD_PATH applies, which is also what "never chosen one"
  /// looks like, so both land on the same fallback.
  prd?: string | null;
  // True for contexts outside the workspace root, listed via the root
  // config's extra_contexts. Optional so old test fixtures stay valid.
  outside?: boolean;
}

export interface GavinTree {
  rootPath: string;
  rootMissing: boolean;
  contexts: GavinContext[];
}

// One persisted board tab: which workspace's board, filtered to which
// gavin context (mirrors config.rs's BoardTabRecord).
export interface BoardTab {
  workspaceId: string;
  contextFolder: string;
}

/// Which half of a card a card tab shows: the detail panel, or the diff
/// of what its run did to the checkout.
export type CardTabView = "plan" | "changes" | "followups";

// One persisted view tab: something a terminal tab asked to see beside
// itself, living in a pane rather than in a modal (mirrors config.rs's
// CardTabRecord). The run baseline is deliberately absent -- it lives on
// the card's binding, which a re-launch replaces, so a copy here would
// pin the pane to a dead run.
//
// "plan" and "changes" are keyed by `path`, the card they show.
// "followups" is keyed by `sessionId` and carries an empty `path`: an
// agent's queue belongs to the SESSION, not to whatever card it happens
// to be running, and two tabs on one card have two different queues.
// Every walk of this map by path -- retargetCardTabs for a card that
// moved, closablesForArchive for one leaving the board -- matches
// against real card paths, so neither ever claims the empty one.
export interface CardTab {
  workspaceId: string;
  path: string;
  view: CardTabView;
  sessionId?: string;
}
