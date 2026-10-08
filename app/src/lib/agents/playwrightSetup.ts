/// The Playwright setup step's pure model. The evidence comes from Rust
/// (`app/src-tauri/src/agent_playwright.rs`): three checks on the machine
/// a workspace's agents run on -- Node's `npx`, the pinned Chrome Headless
/// Shell, and a `playwright` server in this agent's MCP config. What this
/// module owns is what the step does with them, and the two answers gavin
/// keeps for the human itself: "not now", and -- where gavin cannot check
/// -- "I've set it up". When the step counts as done is
/// `setupWizard.ts`'s (`playwrightStepDone`).
///
/// Design: `docs/superpowers/specs/2026-10-08-playwright-integration-design.md`.

/// The product, as the step names it.
export const PLAYWRIGHT_NAME = "Playwright";

/// What the checks found. `unavailable` is gavin unable to look -- a
/// custom agent, an MCP config that does not parse -- never "absent".
export type PlaywrightState = "verified" | "absent" | "unavailable";

export interface PlaywrightCheck {
  id: "npx" | "browser" | "entry";
  /// Found, not found, or null where gavin could not look.
  ok: boolean | null;
  line: string;
}

/// A `playwright` server already in the config that gavin did not write,
/// verbatim, so Replace says what it removes.
export interface PlaywrightConflict {
  file: string;
  command: string;
  args: string[];
}

export interface PlaywrightStatus {
  state: PlaywrightState;
  /// One sentence: what is missing, or why gavin cannot tell.
  detail: string;
  /// `npx`, `browser`, `entry`, in that order.
  checks: PlaywrightCheck[];
  /// The browser install, exactly as gavin runs it.
  command: string;
  /// Whether Install would do something here.
  installable: boolean;
  conflict: PlaywrightConflict | null;
  /// The checks' evidence, or the install's output after one.
  output: string;
}

/// What can be said about Playwright for one workspace. Not landed yet is
/// `undefined`, never one of these, for `setupProgress`'s `pending` rule.
export type PlaywrightReading =
  /// What the checks found.
  | { kind: "status"; status: PlaywrightStatus }
  /// The ask failed. Settled, so nothing waits on it, but not done.
  | { kind: "error"; message: string }
  /// The step cannot serve this workspace from here: an ssh workspace,
  /// whose agents run on the host (`workspacePlaywrightReading`).
  | { kind: "elsewhere"; reason: string };

export const SSH_PLAYWRIGHT_ELSEWHERE =
  "Set up on the host: an ssh workspace's agents run there, and the setup wizard works on this machine's disk.";

/// The reading for one workspace: the checks', except where the workspace
/// itself puts the step out of this machine's reach.
export function workspacePlaywrightReading(
  reading: PlaywrightReading | undefined,
  ws: { ssh?: unknown } | null | undefined
): PlaywrightReading | undefined {
  if (ws?.ssh) return { kind: "elsewhere", reason: SSH_PLAYWRIGHT_ELSEWHERE };
  return reading;
}

/// A status call as a reading. A rejection still settles: the wizard is
/// held back while any input is pending, so a failed ask must land.
export function toPlaywrightReading(ask: Promise<PlaywrightStatus>): Promise<PlaywrightReading> {
  return ask.then(
    (status): PlaywrightReading => ({ kind: "status", status }),
    (e: unknown): PlaywrightReading => ({ kind: "error", message: String(e) })
  );
}

/// The human's word for one root on this machine. `undefined` is "not
/// asked yet", never "not now" -- the step's second way to finish
/// depends on telling the two apart.
export type PlaywrightMark = "installed" | "skipped";

// Machine-local, in the webview's own storage, for the reason the Memory
// step's "not now" is (`memoryIndex.ts`): the browser is a download onto
// THIS machine, which no other machine's answer settles, and config.json
// is shared with the other build and carried through by hand
// (sidebarPrefs.ts's header) -- a cost one word per root does not need.
// Injected storage, so vitest's node environment and an SSR pass
// remember nothing rather than throw.

type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export const PLAYWRIGHT_MARKS_KEY = "gavin.playwrightMarks";

function marks(storage: MaybeStorage): Record<string, PlaywrightMark> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PLAYWRIGHT_MARKS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, PlaywrightMark> = {};
    for (const [root, mark] of Object.entries(parsed)) {
      if (mark === "installed" || mark === "skipped") out[root] = mark;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadPlaywrightMark(
  root: string,
  storage: MaybeStorage = defaultStorage()
): PlaywrightMark | undefined {
  return marks(storage)[root];
}

/// `null` forgets what was said: an Install takes back a "not now".
export function savePlaywrightMark(
  root: string,
  mark: PlaywrightMark | null,
  storage: MaybeStorage = defaultStorage()
): void {
  const all = marks(storage);
  if (mark) all[root] = mark;
  else delete all[root];
  try {
    storage?.setItem(PLAYWRIGHT_MARKS_KEY, JSON.stringify(all));
  } catch {
    // Best-effort: a full or blocked storage asks again next time.
  }
}

export type PlaywrightTone = "on" | "claimed" | "off" | "unknown";

export interface PlaywrightStepView {
  tone: PlaywrightTone;
  label: string;
  line: string;
  checks: PlaywrightCheck[];
  /// The button that does something: Install, or Replace where the config
  /// already has someone else's `playwright` server. Only where the
  /// checks found something missing that gavin can put there.
  action: "install" | "replace" | null;
  /// What Replace removes, verbatim.
  conflict: PlaywrightConflict | null;
  /// The install line to run by hand, where gavin will not run it.
  manualCommand: string | null;
  /// Whether to offer "I've set it up": only where gavin could not look,
  /// and only until the human has said it.
  assert: boolean;
  output: string;
}

const NOTHING = { checks: [], action: null, conflict: null, manualCommand: null, assert: false, output: "" };

export function playwrightStepView(
  reading: PlaywrightReading,
  mark: PlaywrightMark | undefined
): PlaywrightStepView {
  if (reading.kind === "elsewhere") {
    return { ...NOTHING, tone: "unknown", label: "Not here", line: reading.reason };
  }
  if (reading.kind === "error") {
    return { ...NOTHING, tone: "unknown", label: "Not checked", line: reading.message };
  }
  const { status } = reading;
  const shared = { checks: status.checks, conflict: status.conflict, output: status.output };
  switch (status.state) {
    case "verified":
      return { ...NOTHING, ...shared, tone: "on", label: "Ready", line: status.detail };
    case "absent":
      return {
        ...NOTHING,
        ...shared,
        tone: "off",
        label: "Not set up",
        line: status.detail,
        action: status.installable ? (status.conflict ? "replace" : "install") : null,
        manualCommand: status.installable ? null : status.command || null,
      };
    default:
      if (mark === "installed") {
        return {
          ...NOTHING,
          ...shared,
          tone: "claimed",
          label: "Set up (your word)",
          line: "You told gavin Playwright is set up for this agent. gavin has not confirmed it.",
        };
      }
      return {
        ...NOTHING,
        ...shared,
        tone: "unknown",
        label: "Not checked",
        line: status.detail,
        manualCommand: status.command || null,
        assert: true,
      };
  }
}

export function playwrightActionLabel(action: "install" | "replace"): string {
  return action === "replace" ? "Replace with gavin's" : "Install";
}
