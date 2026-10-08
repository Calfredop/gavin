// The adopted-memory index, as the setup surfaces read it
// (`feat-vectorized-memory.md`).
//
// `### Learned` is the durable store (memoryCard.ts writes it); the
// daemon keeps a vector index derived from it so an agent can search the
// adopted facts by meaning (`gavin_search_memories`). The index needs an
// embedding model on this machine -- a one-time download -- and has to
// be brought up to the file. This module decides, from the daemon's
// answer, whether a workspace's Memory step is done, what the step says,
// and whether opening the workspace should bring the index up by itself.
// The asking is memoryIndexState.ts's.
//
// Pure.

/// The daemon's `MemoryIndexStatus` (v60).
export interface MemoryIndexStatus {
  /// `absent`, `downloading`, `ready` or `failed`; a word a newer daemon
  /// adds reaches here as written.
  model: string;
  modelError: string | null;
  /// Memories `### Learned` holds, once each.
  learned: number;
  /// Of those, how many the index holds.
  indexed: number;
  /// The index holds exactly `### Learned`.
  inSync: boolean;
}

/// What can be said about one workspace's index. A reading that has not
/// landed is `undefined`, never one of these -- `headroomSetup.ts`'s rule,
/// for its reason: "not asked yet" read as "absent" opens the wizard on a
/// step that is already done.
export type MemoryReading =
  | { kind: "status"; status: MemoryIndexStatus }
  /// The daemon is too old to be asked (`FEATURE_MIN_VERSION.memoryIndex`).
  | { kind: "blocked"; reason: string }
  /// The ask failed. Settled, so nothing waits on it for ever.
  | { kind: "error"; message: string }
  /// The index cannot serve this workspace from this machine.
  | { kind: "unavailable"; reason: string };

export const SSH_MEMORY_UNAVAILABLE =
  "Unavailable for an ssh workspace: its agents run on the host, and search the memories there.";

/// The reading for one workspace: what the daemon said, except where the
/// workspace itself rules the local index out.
export function workspaceMemoryReading(
  reading: MemoryReading | undefined,
  ws: { ssh?: unknown } | null | undefined
): MemoryReading | undefined {
  if (ws?.ssh) return { kind: "unavailable", reason: SSH_MEMORY_UNAVAILABLE };
  return reading;
}

/// The model is here and the index holds exactly `### Learned` -- with
/// nothing adopted yet, an empty index is exactly that.
export function memoryIndexReady(status: MemoryIndexStatus): boolean {
  return status.model === "ready" && status.inSync;
}

/// Whether the Memory step is finished: the index is ready, the human
/// said "not now", or there is nothing this machine can do for the
/// workspace. An unknown reading is not done, and neither is a failed
/// ask: gavin failing to find out is not the index being ready.
export function memoryStepDone(reading: MemoryReading | undefined, skipped: boolean): boolean {
  if (skipped) return true;
  if (reading?.kind === "unavailable") return true;
  return reading?.kind === "status" && memoryIndexReady(reading.status);
}

/// Whether the step's answer is known. "Not now" settles it on its own:
/// no reading in flight can undo the human having declined.
export function memoryStepSettled(reading: MemoryReading | undefined, skipped: boolean): boolean {
  return skipped || reading !== undefined;
}

/// Whether opening this workspace should bring its index up by itself:
/// it has memories, the index does not match them, nobody said "not
/// now", and nothing is already downloading. Opening a workspace with
/// nothing adopted downloads nothing -- that first download is the
/// Memory step's to offer.
export function backfillWanted(reading: MemoryReading | undefined, skipped: boolean): boolean {
  if (skipped || reading?.kind !== "status") return false;
  const { status } = reading;
  return status.learned > 0 && status.model !== "downloading" && !memoryIndexReady(status);
}

/// Whether what the step shows is changing by itself right now.
export function memoryPollFast(reading: MemoryReading | undefined): boolean {
  return reading?.kind === "status" && reading.status.model === "downloading";
}

export interface MemoryStepView {
  /// The state's name, or what stands in for one.
  label: string;
  tone: "on" | "off" | "warn" | "unknown";
  /// One sentence on where the index stands.
  line: string;
  /// The button that downloads the model and builds the index, or null
  /// when there is nothing for it to do.
  action: string | null;
  busy: boolean;
}

function memoryCount(n: number): string {
  return `${n} adopted ${n === 1 ? "memory" : "memories"}`;
}

/// What the Memory step draws for a reading.
export function memoryStepView(reading: MemoryReading | undefined): MemoryStepView {
  if (!reading) return { label: "Checking…", tone: "unknown", line: "", action: null, busy: false };
  switch (reading.kind) {
    case "blocked":
      return { label: "Needs a newer daemon", tone: "unknown", line: reading.reason, action: null, busy: false };
    case "error":
      return {
        label: "Unknown",
        tone: "unknown",
        line: `Couldn't ask the daemon about the memory index: ${reading.message}`,
        action: "Try again",
        busy: false,
      };
    case "unavailable":
      return { label: "Unavailable", tone: "off", line: reading.reason, action: null, busy: false };
    case "status":
      break;
  }
  const s = reading.status;
  if (s.model === "downloading") {
    return {
      label: "Downloading",
      tone: "unknown",
      line: "Downloading the embedding model (about 64 MB, once for every workspace). The index is built from this workspace's memories as soon as it lands.",
      action: null,
      busy: true,
    };
  }
  if (s.model === "failed") {
    return {
      label: "Download failed",
      tone: "warn",
      line: `The embedding model didn't download${s.modelError ? `: ${s.modelError}` : "."}`,
      action: "Try again",
      busy: false,
    };
  }
  if (s.model !== "ready") {
    return {
      label: "Not set up",
      tone: "off",
      line:
        s.learned > 0
          ? `This workspace has ${memoryCount(s.learned)}. Agents can search them by meaning once gavin has its embedding model — a one-time download of about 64 MB, run on this machine.`
          : "Agents can search adopted memories by meaning once gavin has its embedding model — a one-time download of about 64 MB, run on this machine. Nothing is adopted here yet.",
      action: "Download and build the index",
      busy: false,
    };
  }
  if (!s.inSync) {
    return {
      label: "Out of date",
      tone: "warn",
      line: `The index holds ${s.indexed} of ${memoryCount(s.learned)}.`,
      action: "Build the index",
      busy: false,
    };
  }
  return {
    label: "Ready",
    tone: "on",
    line:
      s.learned > 0
        ? `Indexed ${memoryCount(s.learned)}. Agents search them with gavin_search_memories.`
        : "Ready. Memories you adopt are indexed as you adopt them.",
    action: null,
    busy: false,
  };
}

/// What Adopt says when the fact landed in `### Learned` but the index
/// did not take it. Not a failure of the adopt -- the file is the store,
/// and the next search heals the index from it -- so it says that.
export function adoptIndexNotice(message: string): string {
  return `Adopted. The memory index didn't take it yet (${message}); the next search will.`;
}

// ---- "not now" ----------------------------------------------------------
//
// Per machine and per root, in localStorage: declining is declining a
// download onto THIS machine, which no other machine's answer settles,
// and AppConfig's carry-through cost (sidebarPrefs.ts's header) buys
// nothing for one boolean. Injected storage, for the reasons
// sidebarPrefs.ts injects it: vitest's node environment and an SSR pass
// have none, and both must remember nothing rather than throw.

type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export const MEMORY_SKIPPED_KEY = "gavin.memorySkippedRoots";

function skippedRoots(storage: MaybeStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(MEMORY_SKIPPED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/// Whether the human said "not now" to the Memory step for this root.
export function loadMemorySkipped(root: string, storage: MaybeStorage = defaultStorage()): boolean {
  return skippedRoots(storage).includes(root);
}

export function saveMemorySkipped(
  root: string,
  skipped: boolean,
  storage: MaybeStorage = defaultStorage()
): void {
  const roots = skippedRoots(storage).filter((r) => r !== root);
  if (skipped) roots.push(root);
  try {
    storage?.setItem(MEMORY_SKIPPED_KEY, JSON.stringify(roots));
  } catch {
    // Best-effort: a full or blocked storage asks again next time.
  }
}
