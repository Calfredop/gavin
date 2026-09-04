// TypeScript mirrors of crates/protocol's gavin tree shapes (camelCase on
// the wire via serde, verified by the protocol crate's shape tests).

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
export type CardTabView = "plan" | "changes";

// One persisted card tab: a card's own view living in a pane rather than
// in a modal (mirrors config.rs's CardTabRecord). The run baseline is
// deliberately absent -- it lives on the card's binding, which a
// re-launch replaces, so a copy here would pin the pane to a dead run.
export interface CardTab {
  workspaceId: string;
  path: string;
  view: CardTabView;
}
