// Headroom's setup surfaces, as rules (`2026-09-28-headroom-design.md`,
// "Detection and install", "The switch" and "Platforms").
//
// Three surfaces draw Headroom: the app-wide Settings section, the switch
// on a workspace's Settings tab, and the setup wizard's step. What each
// shows for a given reading of Headroom's status -- which state, which
// actions, which reason -- is decided here, so the three cannot disagree
// about what a state means, and every state's actions are tested without
// a window. The `.svelte` files are templates over these values.
//
// Pure. The reading comes from `headroomState.ts`, which asks the daemon;
// the switch's stored value and its default are `compression.ts`'s.

import { normalizeHeadroom, type HeadroomStatus } from "$lib/agents/compression";
import type { ApiFamily } from "$lib/agents/apiFamily";
import { formatTokens } from "$lib/cards/runHistory";
import type { ConfirmOptions } from "$lib/core/dialog";

/// What can be said about Headroom right now. A reading that has not
/// landed is `undefined`, never one of these: "not asked yet" read as
/// "absent" would offer an Install for a Headroom that is there, and open
/// the wizard on a step that is already answered (the `pending` trap
/// `setupProgress` exists to avoid).
export type HeadroomReading =
  /// What the daemon said.
  | { kind: "status"; status: HeadroomStatus }
  /// The daemon is too old to be asked (`FEATURE_MIN_VERSION.headroomSetup`).
  /// Settled: asking again cannot change the answer until it is restarted.
  | { kind: "blocked"; reason: string }
  /// The ask failed. Settled too, so nothing waits on it for ever.
  | { kind: "error"; message: string }
  /// Headroom cannot serve THIS workspace, whatever the machine has: an
  /// ssh workspace's agents run on its host (`workspaceHeadroomReading`).
  | { kind: "unavailable"; reason: string };

/// Why an ssh workspace is Unavailable (spec, "Platforms").
export const SSH_UNAVAILABLE =
  "Unavailable for an ssh workspace: its agents run on the host, and compressing them would need Headroom installed and run there.";

/// The reading for one workspace: the machine's, except where the
/// workspace itself rules Headroom out.
export function workspaceHeadroomReading(
  reading: HeadroomReading | undefined,
  ws: { ssh?: unknown } | null | undefined
): HeadroomReading | undefined {
  if (ws?.ssh) return { kind: "unavailable", reason: SSH_UNAVAILABLE };
  return reading;
}

/// The name a state is shown under. A word a newer daemon added reaches
/// here as written rather than as one of these.
export function headroomStateLabel(state: string): string {
  switch (state) {
    case "verified":
      return "Verified";
    case "too-old":
      return "Too old";
    case "absent":
      return "Absent";
    case "unavailable":
      return "Unavailable";
    default:
      return state;
  }
}

// ---- versions -----------------------------------------------------------

interface ParsedVersion {
  numbers: [number, number, number];
  released: boolean;
}

/// `X.Y.Z`, optionally followed by a pre-release tag: the daemon's own
/// `Version::parse` rule (`headroom/version.rs`), where a pre-release
/// sorts below the release it precedes. Anything else is not placed.
function parseVersion(text: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(text.trim());
  if (!m) return null;
  const tag = m[4].replace(/^\./, "");
  if (tag !== "" && !/^(rc|a|b|dev)\d+$/.test(tag)) return null;
  return { numbers: [Number(m[1]), Number(m[2]), Number(m[3])], released: tag === "" };
}

/// Negative when `a` is older, positive when newer, 0 when level; null
/// when either is not a version this can place.
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] - y.numbers[i];
  }
  return Number(x.released) - Number(y.released);
}

/// Whether gavin's pin has moved past what is installed: Settings'
/// Update. A Too old Headroom is always below the pin, which is above the
/// floor, so Update is also how a too-old one is brought up. Never
/// offered above the pin: gavin does not downgrade the human's own
/// upgrade, it says "newer than tested" instead.
export function updateOffered(status: HeadroomStatus): boolean {
  if (status.state !== "verified" && status.state !== "too-old") return false;
  if (!status.version) return false;
  const order = compareVersions(status.version, status.pin);
  return order !== null && order < 0;
}

// ---- the actions --------------------------------------------------------

export type HeadroomAction = "install" | "update" | "locate" | "check-again";

/// What each action's button says, and what it says while it is being
/// done. The install's wait is short -- the daemon answers as soon as it
/// has started, and the progress line takes over -- but a Check again
/// runs `headroom --version`, a Python start.
export function headroomActionLabel(action: HeadroomAction, status: HeadroomStatus, busy = false): string {
  switch (action) {
    case "install":
      return busy ? "Starting the install…" : `Install Headroom ${status.pin}`;
    case "update":
      // Busy while its confirmation is on screen too, where "Updating…"
      // would say it had begun before anyone agreed to it.
      return `Update to ${status.pin}…`;
    case "locate":
      return busy ? "Checking what you picked…" : "Locate…";
    case "check-again":
      return busy ? "Checking…" : "Check again";
  }
}

/// The command that installs the pinned Headroom, for a machine gavin
/// cannot run it on. The same line the daemon runs and prints
/// (`install::command_line`): the Python and the extras are pinned with
/// the version.
export function headroomInstallCommand(pin: string): string {
  return `uv tool install --python 3.13 "headroom-ai[all]==${pin}"`;
}

/// Whether the install is running now. Every action waits while it is:
/// a Check again mid-install reads a half-written tool directory, and the
/// daemon refuses a second install anyway.
export function installRunning(status: HeadroomStatus): boolean {
  return status.install?.state === "running";
}

/// The actions a state offers, most useful first.
///
/// - Absent: Install when `uv` is found; otherwise the command is shown
///   instead, with Locate… and Check again, which are what a human who
///   installs it some other way needs.
/// - Too old: Update, the same install, which puts the pin in place.
/// - Verified below the pin: Update. At or above it: only Check again, for
///   a Headroom upgraded outside gavin -- and Update again after a failed
///   install, which re-runs the model fetch the failure left undone.
/// - Unavailable: nothing. No button can make this machine run it.
export function headroomActions(status: HeadroomStatus): HeadroomAction[] {
  if (installRunning(status)) return [];
  const uv = status.uvFound;
  switch (status.state) {
    case "absent":
      return uv ? ["install", "locate", "check-again"] : ["locate", "check-again"];
    case "too-old":
      return uv ? ["update", "locate", "check-again"] : ["locate", "check-again"];
    case "verified":
      return uv && (updateOffered(status) || status.install?.state === "failed")
        ? ["update", "check-again"]
        : ["check-again"];
    default:
      return [];
  }
}

/// Whether the command is shown for the human to run: the pin wants
/// installing and gavin has no `uv` to install it with.
export function showsInstallCommand(status: HeadroomStatus): boolean {
  if (status.uvFound || installRunning(status)) return false;
  return status.state === "absent" || status.state === "too-old" || updateOffered(status);
}

// ---- the lines ----------------------------------------------------------

/// "0.39.1 · tested 0.39.1", and the state's own note beside it: newer
/// than tested above the pin, the floor under it. Null with nothing found.
export function headroomVersionLine(status: HeadroomStatus): string | null {
  if (!status.version) return null;
  const line = `${status.version} · tested ${status.pin}`;
  if (status.newerThanTested) return `${line} — newer than tested`;
  if (status.state === "too-old") return `${line} · oldest gavin runs ${status.floor}`;
  return line;
}

/// The line that offers the update, in the spec's words.
export function headroomUpdateLine(status: HeadroomStatus): string | null {
  if (!updateOffered(status)) return null;
  return `Headroom ${status.pin} is tested — update from ${status.version}.`;
}

export type HeadroomProcessWord = "running" | "starting" | "stopped" | "failed";

export interface HeadroomProcess {
  word: HeadroomProcessWord;
  line: string;
}

/// Running, stopped or failed, and the port. Starting is running without
/// being ready: the compression model loads for seconds after the
/// process is up.
export function headroomProcess(status: HeadroomStatus): HeadroomProcess {
  const port = status.port === null ? "" : ` on port ${status.port}`;
  const restarts =
    status.restarts > 0 ? ` · restarted ${status.restarts} time${status.restarts === 1 ? "" : "s"}` : "";
  if (status.running && status.ready) {
    return { word: "running", line: `Running${port}${restarts}` };
  }
  if (status.running) {
    return { word: "starting", line: `Starting${port} — loading the compression model${restarts}` };
  }
  if (status.wanted && status.lastError) {
    return { word: "failed", line: `Failed: ${status.lastError}` };
  }
  if (status.wanted) return { word: "starting", line: `Starting${port}` };
  return {
    word: "stopped",
    line: `Stopped — no workspace has compression on${status.port === null ? "" : ` (port ${status.port} is kept for it)`}`,
  };
}

/// The lifetime total, short, and the exact figure for its tooltip. Null
/// when Headroom has never been asked -- which is not the same as having
/// saved nothing, and must not read as "0 tokens".
export function headroomSaved(status: HeadroomStatus): { line: string; exact: string } | null {
  const n = status.lifetimeTokensSaved;
  if (n === null) return null;
  return {
    line: `${formatTokens(n)} tokens saved`,
    exact: `${n.toLocaleString("en-US")} tokens saved since this Headroom was first run`,
  };
}

/// The one residual the spec names: routing is set on the agent's
/// process, so everything that process starts inherits it.
export const HEADROOM_RESIDUAL_NOTE =
  "Compression is set on the agent's own process, so the commands an agent runs inherit its routing: an npm test it starts talks to its model API through Headroom too. Your own terminal tabs never do.";

/// What the section and the step say about the install, while it runs
/// and after it ends.
export interface HeadroomInstallView {
  running: boolean;
  failed: boolean;
  line: string;
  output: string;
}

export function headroomInstallView(status: HeadroomStatus): HeadroomInstallView | null {
  const install = status.install;
  if (!install) return null;
  if (install.state === "running") {
    return {
      running: true,
      failed: false,
      line: `Installing Headroom ${status.pin} and fetching its compression model (about 274 MB). This takes a few minutes.`,
      output: install.output,
    };
  }
  if (install.state === "failed") {
    return { running: false, failed: true, line: "The install failed.", output: install.output };
  }
  return {
    running: false,
    failed: false,
    line: status.state === "verified" ? `Installed Headroom ${status.version ?? status.pin}.` : "The install finished.",
    output: install.output,
  };
}

/// The Update confirmation. `danger`, so the prompt keeps focus on
/// Cancel and Enter cannot fire it: an update restarts the proxy every
/// compressed agent is talking through.
export function headroomUpdateConfirm(status: HeadroomStatus): ConfirmOptions {
  return {
    title: `Update Headroom to ${status.pin}?`,
    lines: [
      `gavin installs Headroom ${status.pin} with uv, the version it was tested against, and fetches its compression model.`,
      "Once it is installed, Headroom restarts on the same port. Every running compressed agent loses the request it had in flight and retries it once.",
      "No workspace's compression switch changes.",
    ],
    confirmLabel: `Update to ${status.pin}`,
    danger: true,
  };
}

// ---- the Settings section -----------------------------------------------

export interface HeadroomSectionView {
  /// The state's name, or what stands in for one.
  label: string;
  /// For the LED: on, off, trouble, or not known.
  tone: "on" | "off" | "warn" | "unknown";
  reason: string | null;
  versionLine: string | null;
  updateLine: string | null;
  process: HeadroomProcess | null;
  saved: { line: string; exact: string } | null;
  actions: HeadroomAction[];
  installCommand: string | null;
  install: HeadroomInstallView | null;
}

const EMPTY: Omit<HeadroomSectionView, "label" | "tone" | "reason"> = {
  versionLine: null,
  updateLine: null,
  process: null,
  saved: null,
  actions: [],
  installCommand: null,
  install: null,
};

/// Everything the Settings section and the wizard's step draw for a
/// reading. Unknown is "Checking…" with no actions at all, never Absent
/// with an Install button.
export function headroomSectionView(reading: HeadroomReading | undefined): HeadroomSectionView {
  if (!reading) return { ...EMPTY, label: "Checking…", tone: "unknown", reason: null };
  switch (reading.kind) {
    case "blocked":
      return { ...EMPTY, label: "Needs a newer daemon", tone: "unknown", reason: reading.reason };
    case "error":
      return {
        ...EMPTY,
        label: "Unknown",
        tone: "unknown",
        reason: `Couldn't ask the daemon about Headroom: ${reading.message}`,
      };
    case "unavailable":
      return { ...EMPTY, label: "Unavailable", tone: "off", reason: reading.reason };
    case "status":
      break;
  }
  const status = reading.status;
  const tone =
    status.state === "verified" ? "on" : status.state === "too-old" ? "warn" : status.state === "absent" ? "off" : "unknown";
  const available = status.state !== "unavailable";
  return {
    label: headroomStateLabel(status.state),
    tone,
    reason: status.reason,
    versionLine: headroomVersionLine(status),
    updateLine: headroomUpdateLine(status),
    // A machine that cannot run it has no process to describe, and a
    // Headroom nobody has installed has only "stopped" to say -- which
    // the state already says better.
    process: available && status.state !== "absent" ? headroomProcess(status) : null,
    saved: available ? headroomSaved(status) : null,
    actions: headroomActions(status),
    installCommand: showsInstallCommand(status) ? headroomInstallCommand(status.pin) : null,
    install: headroomInstallView(status),
  };
}

/// Why the command is on screen instead of an Install button.
export const NO_UV_NOTE =
  "gavin installs Headroom with uv, and uv isn't on this machine. Install uv and press Check again, or install Headroom yourself and Locate… it:";

// ---- the switch ---------------------------------------------------------

/// The `<select>` vocabulary, `requireReviewOptions`'s shape: "" is the
/// inherit row, which clears the workspace's own choice.
export const HEADROOM_INHERIT = "";
export const HEADROOM_ON = "on";
export const HEADROOM_OFF = "off";

export function headroomFromSelect(value: string): boolean | null {
  if (value === HEADROOM_ON) return true;
  if (value === HEADROOM_OFF) return false;
  return null;
}

export function headroomToSelect(value: unknown): string {
  const normalized = normalizeHeadroom(value);
  if (normalized === null) return HEADROOM_INHERIT;
  return normalized ? HEADROOM_ON : HEADROOM_OFF;
}

/// The rows, the inherit row naming what it inherits: a box whose
/// selected row is secretly doing something is the one thing a settings
/// panel must not show.
export function headroomOptions(inherited: boolean): { value: string; label: string }[] {
  return [
    { value: HEADROOM_INHERIT, label: `Default (${inherited ? "on" : "off"})` },
    { value: HEADROOM_ON, label: "On" },
    { value: HEADROOM_OFF, label: "Off" },
  ];
}

/// Why a profile's agents are not compressed even with the switch on, or
/// null for one that is (spec, "The recipes"; the daemon's `unroutable`).
export function profileRecipeReason(profileId: string, customApiFamily: ApiFamily): string | null {
  switch (profileId) {
    case "claude-code":
    case "codex":
    case "opencode":
      return null;
    case "cursor":
      return "Cursor sends everything through Cursor's servers — Headroom can't reach it.";
    case "gemini":
      return "Gemini is compressed only when its CLI uses an API key. Login with Google isn't routed: Google's endpoint for it is documented for testing only, and Headroom can't undo lossy compression on streamed Gemini replies.";
    case "custom":
      return customApiFamily
        ? null
        : "The custom agent isn't compressed until it names the API it speaks — set its API family in Settings → Custom agent.";
    default:
      return "gavin has no way to route this agent through Headroom.";
  }
}

export interface HeadroomSwitchInput {
  /// The reading for this workspace (`workspaceHeadroomReading`).
  reading: HeadroomReading | undefined;
  /// Why the daemon cannot take the switch, or null
  /// (`compressionSwitchBlocked`).
  switchBlocked: string | null;
  /// The workspace's own agent profile.
  profileId: string;
  customApiFamily: ApiFamily;
}

export interface HeadroomSwitchView {
  disabled: boolean;
  /// "Unavailable" where Headroom cannot serve this workspace at all.
  unavailable: boolean;
  /// Shown under the control, most important first.
  notes: string[];
}

/// The workspace switch. Dark only where moving it could not change a
/// single launch -- an ssh workspace, a platform Headroom cannot run on,
/// a daemon that cannot take it. Everywhere else it can be turned on
/// ahead of the install, and says what stands between it and a
/// compressed agent.
export function headroomSwitchView(input: HeadroomSwitchInput): HeadroomSwitchView {
  const { reading } = input;
  if (reading?.kind === "unavailable") {
    return { disabled: true, unavailable: true, notes: [reading.reason] };
  }
  if (reading?.kind === "status" && reading.status.state === "unavailable") {
    return { disabled: true, unavailable: true, notes: reading.status.reason ? [reading.status.reason] : [] };
  }
  if (input.switchBlocked) {
    return { disabled: true, unavailable: false, notes: [input.switchBlocked] };
  }
  const notes: string[] = [];
  const profile = profileRecipeReason(input.profileId, input.customApiFamily);
  if (profile) notes.push(profile);
  if (reading?.kind === "status") {
    const { status } = reading;
    if (status.state === "absent") {
      notes.push("Headroom isn't installed, so agents launch uncompressed until it is. Install it in Settings → Headroom.");
    } else if (status.state === "too-old") {
      const which = status.version ? `Headroom ${status.version}` : "This Headroom";
      notes.push(
        `${which} is too old for gavin to run, so agents launch uncompressed until it is updated in Settings → Headroom.`
      );
    }
  } else if (reading?.kind === "error") {
    notes.push(`Couldn't ask the daemon about Headroom: ${reading.message}`);
  } else if (reading?.kind === "blocked") {
    notes.push(reading.reason);
  }
  return { disabled: false, unavailable: false, notes };
}

/// Why the app-wide default is dark, or null. Only what makes moving it
/// pointless: a machine Headroom cannot run on, a daemon that cannot take
/// the switch. It sits under the section that already says whether
/// Headroom is installed, so it repeats none of that.
export function headroomDefaultBlocked(
  reading: HeadroomReading | undefined,
  switchBlocked: string | null
): string | null {
  if (reading?.kind === "status" && reading.status.state === "unavailable") {
    return reading.status.reason ?? "Headroom is unavailable on this machine.";
  }
  return switchBlocked;
}

// ---- the wizard's step --------------------------------------------------

/// What the step offers: the workspace's switch once Headroom is Verified,
/// the install while it is Absent or Too old.
export function headroomStepOffers(reading: HeadroomReading | undefined): {
  switch: boolean;
  install: boolean;
} {
  if (reading?.kind !== "status") return { switch: false, install: false };
  const { state } = reading.status;
  return { switch: state === "verified", install: state === "absent" || state === "too-old" };
}

/// Whether the step is finished: the question was put (`headroomAsked`),
/// or there is no question to put -- Headroom cannot serve this workspace,
/// on this machine or over ssh.
///
/// An unknown reading is not done, and neither is a failed ask: gavin
/// failing to find out is not the human deciding.
export function headroomStepDone(reading: HeadroomReading | undefined, asked: boolean): boolean {
  if (asked) return true;
  if (reading?.kind === "unavailable") return true;
  return reading?.kind === "status" && reading.status.state === "unavailable";
}

/// Whether the step's answer is known. A recorded answer settles it on
/// its own, whatever the reading: no reading still in flight can undo
/// the human having been asked.
export function headroomStepSettled(reading: HeadroomReading | undefined, asked: boolean): boolean {
  return asked || reading !== undefined;
}
