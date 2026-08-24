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
}

export interface MdFileInfo {
  path: string;
  relPath: string;
}

export interface AgentConfig {
  profile: string | null;
  file: string | null;
  command: string | null;
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
