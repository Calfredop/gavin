// What the machine's memory reading MEANS. Every judgement the memory
// wall makes, with nothing that needs a daemon, a host or a DOM.
//
// The host (`app/src-tauri/src/memory.rs`) reads raw values -- the
// kernel's own pressure level, `watch-list`'s stdout, byte counts -- and
// hands them over untouched. Interpreting them here rather than there is
// deliberate: the words "warn" and "critical" gate every launch in the
// app, and a rule that decides whether work starts belongs in the file
// with the tests beside it, not behind an FFI call nothing can drive.
//
// The one number in here that is not measured is `MIN_AGENT_RSS_BYTES`.
// It is a FLOOR on the estimate, not a guess at the truth: an agent
// process tree in this app -- the CLI, its MCP servers, the language
// server and whatever build it started -- has never been seen under a
// gigabyte and a half, so an estimate that came out lower would be the
// estimate that let eleven of them start at once.

/// What the kernel thinks of the machine's memory right now.
///
/// Three words rather than a percentage because the kernel is answering
/// a different question from "how full is it": pressure is about how
/// hard it is having to work to keep pages available, which is what
/// actually precedes a thrash.
export type MemoryPressure = "normal" | "warn" | "critical";

/// One reading of the machine, as `memory.rs` hands it over.
export interface SystemMemorySample {
  supported: boolean;
  totalBytes: number;
  freePercent: number;
  /// The kernel's raw `kern.memorystatus_vm_pressure_level`: 1 normal,
  /// 2 warn, 4 critical. Zero means the sysctl did not answer.
  pressureLevel: number;
  swapUsedBytes: number;
  sampledAtMs: number;
}

/// A live watchman server, as `memory.rs` hands it over. Null when there
/// is not one -- which is the common case, and is not the same as a
/// server watching nothing.
export interface WatchmanSample {
  pid: number;
  rssBytes: number;
  /// `watchman watch-list`'s raw stdout, parsed by `rootsFromWatchList`.
  rootsJson: string;
}

/// The kernel's pressure level, in words.
///
/// Anything that is not one of the three documented values reads as
/// `normal`, including the 0 the host writes when the sysctl did not
/// answer. That is the safe direction and the only honest one: an
/// unmeasured machine must behave exactly as gavin did before this
/// feature existed, and inventing "critical" from a failed read would
/// hold every launch on a machine with nothing wrong with it.
export function pressureFromLevel(level: number): MemoryPressure {
  if (level === 4) return "critical";
  if (level === 2) return "warn";
  return "normal";
}

/// The pressure a whole sample carries. An unsupported host is `normal`
/// for the reason above: no measurement is not a bad measurement.
export function pressureOf(sample: SystemMemorySample | null): MemoryPressure {
  if (!sample || !sample.supported) return "normal";
  return pressureFromLevel(sample.pressureLevel);
}

/// Bytes in use, or null when nothing was measured.
///
/// Derived from the kernel's free PERCENTAGE rather than from a page
/// count, because that percentage is the figure the kernel itself acts
/// on -- free pages on a Mac read near zero at all times, and a bar
/// built on them would sit at 100% for ever.
export function usedBytes(sample: SystemMemorySample | null): number | null {
  if (!sample || !sample.supported || sample.totalBytes <= 0) return null;
  const free = Math.min(100, Math.max(0, sample.freePercent)) / 100;
  return Math.round(sample.totalBytes * (1 - free));
}

/// Bytes still available, or null when nothing was measured.
export function freeBytes(sample: SystemMemorySample | null): number | null {
  const used = usedBytes(sample);
  if (used === null || !sample) return null;
  return Math.max(0, sample.totalBytes - used);
}

const GB = 1024 ** 3;

/// A size for a SENTENCE, not for a column.
///
/// `sessionsManager.formatMemory` is the grid's format and stays the
/// grid's: it has a fixed width to respect and drops to MB and KB. This
/// one is the voice the gate speaks in -- "26 of 32 GB", "≈ 17 GB" --
/// where every figure is gigabytes and a decimal point on a two-digit
/// number is noise. Under ten it keeps one decimal, because the floor
/// itself is 1.5 GB and "2 GB each" would misstate it.
export function formatGb(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 0.1) return `${Number(gb.toFixed(1))} GB`;
  // Below a tenth of a gigabyte the answer is "nothing worth counting",
  // and "0.1 GB" would overstate it.
  return "<0.1 GB";
}

/// Two sizes that share a unit: "28 of 32 GB".
///
/// One "GB", not two. The gate's sentences put a used figure beside a
/// total in the same breath, and repeating the unit reads as two
/// separate measurements rather than one ratio.
export function formatGbPair(used: number, total: number): string {
  return `${formatGb(used).replace(/ GB$/, "")} of ${formatGb(total)}`;
}

/// The roots a live watchman is holding.
///
/// `watch-list` answers `{"version": "…", "roots": ["/a", "/b"]}`. Every
/// other shape -- an empty string because the CLI could not be run, a
/// truncated body, an error object -- is an empty list rather than a
/// throw: this feeds a strip and a menu, and neither is worth taking the
/// poll down for.
export function rootsFromWatchList(json: string): string[] {
  if (!json.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return [];
    const roots = (parsed as { roots?: unknown }).roots;
    if (!Array.isArray(roots)) return [];
    return roots.filter((r): r is string => typeof r === "string" && r.length > 0);
  } catch {
    return [];
  }
}

/// The smallest an agent's process tree is ever assumed to be.
///
/// A floor, not an average. The estimate exists to stop a burst of
/// launches, so it must never come out below what one launch actually
/// costs -- and the measured figure is regularly lower than the truth
/// for an agent that has only just started and has not yet spawned its
/// MCP servers or its build.
export const MIN_AGENT_RSS_BYTES = 1.5 * GB;

/// One measured agent session: what its whole process tree occupies, and
/// which profile launched it.
export interface AgentSample {
  sessionId: string;
  /// The agent profile id this session runs, or null when nothing knows
  /// -- an adopted session, or a workspace with no profile resolved.
  profileId: string | null;
  rssBytes: number;
  processCount: number;
}

/// Mean tree RSS per profile, floored.
///
/// Per PROFILE rather than one number for the fleet because the profiles
/// genuinely differ -- a Claude Code tree with three MCP servers is not
/// an opencode one -- and because the estimate is always about a
/// specific next launch, which has a profile.
///
/// A session measured at zero is left OUT of the mean rather than
/// counted as free: zero is what an unmeasured row carries (an older
/// daemon, a session whose pid the daemon never verified), and averaging
/// it in would drag the estimate under the floor with no measurement
/// behind it.
export function meanRssByProfile(samples: AgentSample[]): Record<string, number> {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const s of samples) {
    if (!s.profileId || s.rssBytes <= 0) continue;
    const entry = totals.get(s.profileId) ?? { sum: 0, count: 0 };
    entry.sum += s.rssBytes;
    entry.count += 1;
    totals.set(s.profileId, entry);
  }
  const out: Record<string, number> = {};
  for (const [profileId, { sum, count }] of totals) {
    out[profileId] = Math.max(MIN_AGENT_RSS_BYTES, sum / count);
  }
  return out;
}

/// What ONE more agent of this profile should be assumed to cost.
///
/// Three sources in order, and the order is the whole point: what the
/// running agents of that profile actually measure, then what they
/// measured last time gavin looked, then the floor. Never below the
/// floor, at any step -- a stored mean from a machine that once ran one
/// quiet agent must not authorise eleven.
export function perAgentEstimate(
  profileId: string | null,
  means: Record<string, number>,
  stored: Record<string, number> = {}
): number {
  const live = profileId ? means[profileId] : undefined;
  if (live && live > 0) return Math.max(MIN_AGENT_RSS_BYTES, live);
  const remembered = profileId ? stored[profileId] : undefined;
  if (remembered && remembered > 0) return Math.max(MIN_AGENT_RSS_BYTES, remembered);
  return MIN_AGENT_RSS_BYTES;
}

/// What the fleet's agents are holding right now.
export interface FleetMemory {
  /// Total resident bytes across every measured agent tree.
  rssBytes: number;
  /// How many agent sessions that covers.
  agents: number;
  /// Mean tree RSS per profile id, floored (`meanRssByProfile`).
  meanByProfile: Record<string, number>;
}

export function fleetMemory(samples: AgentSample[]): FleetMemory {
  return {
    rssBytes: samples.reduce((total, s) => total + Math.max(0, s.rssBytes), 0),
    agents: samples.length,
    meanByProfile: meanRssByProfile(samples),
  };
}

// ---- Persistence ------------------------------------------------------------
//
// localStorage, beside the usage history and the orchestration
// conflicts box. No daemon request, so no protocol bump and no compat
// gate -- and nothing outside this window needs the figure.
//
// Persisting at all matters for one case: the FIRST launch after a
// restart. Nothing is running, so there is no sample to average, and
// without a remembered mean every estimate would fall back to the floor
// -- which understates a Claude Code tree by two thirds and is exactly
// the reading that would wave a burst through.

export const MEAN_RSS_KEY = "gavin.agentMeanRss";

/// Injected (defaulting to the browser's) for the same reason every
/// other preference module injects it: vitest's node environment has no
/// localStorage, and an SSR pass has none either.
type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/// A stored blob, with every entry checked.
///
/// A hand-edited or half-written file must read as "nothing remembered"
/// rather than poison the estimate: a NaN here would propagate through
/// every arithmetic in `launchEstimate` and print a sentence with a
/// "NaN GB" in it, and a negative would authorise any burst at all.
export function parseStoredMeans(raw: string | null): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [profileId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    out[profileId] = Math.max(MIN_AGENT_RSS_BYTES, value);
  }
  return out;
}

export function loadStoredMeans(storage: MaybeStorage = defaultStorage()): Record<string, number> {
  try {
    return parseStoredMeans(storage?.getItem(MEAN_RSS_KEY) ?? null);
  } catch {
    return {};
  }
}

export function saveStoredMeans(
  means: Record<string, number>,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    if (Object.keys(means).length === 0) storage?.removeItem(MEAN_RSS_KEY);
    else storage?.setItem(MEAN_RSS_KEY, JSON.stringify(means));
  } catch {
    // A full or disabled store costs the estimate its memory across a
    // reload and nothing else. The floor still applies.
  }
}

// ---- The fleet strip --------------------------------------------------------
//
// One line, drawn in the sidebar footer beside the pause badge and again
// on the app hub. The same words in both places, from one function, for
// the reason `workspaceRecapLine` already gives: the two are on screen
// together and two arithmetics for one number is the shape that drifts.

export interface FleetStrip {
  /// "Agents 4/4 · 26 of 32 GB". Never a zero nobody measured: a half
  /// that could not be read is left out rather than printed as 0.
  text: string;
  /// The same five-value scale `IndicatorTone` uses, so a strip and a
  /// badge beside it are the same amber.
  tone: "neutral" | "warning" | "danger";
}

export interface FleetStripInput {
  /// Agents working or asking, app-wide.
  inFlight: number;
  /// The ceiling in force, or null for none.
  ceiling: number | null;
  /// The machine, or null when nothing was measured.
  sample: SystemMemorySample | null;
  pressure: MemoryPressure;
}

/// The strip, or null when there is nothing worth a row.
///
/// Null is the ordinary quiet state: no agents running and a machine
/// under no pressure is exactly the case where a permanent "Agents 0/4 ·
/// 9 of 32 GB" would train the eye to skip the row -- and this row has to
/// be readable on the one day it says something.
export function fleetStrip(input: FleetStripInput): FleetStrip | null {
  const used = usedBytes(input.sample);
  const total = input.sample?.supported ? input.sample.totalBytes : null;
  const quiet = input.inFlight === 0 && input.pressure === "normal";
  if (quiet) return null;

  const parts: string[] = [];
  parts.push(
    input.ceiling !== null && input.ceiling > 0
      ? `Agents ${input.inFlight}/${input.ceiling}`
      : `Agents ${input.inFlight}`
  );
  if (used !== null && total !== null) parts.push(formatGbPair(used, total));

  const tone =
    input.pressure === "critical" ? "danger" : input.pressure === "warn" ? "warning" : "neutral";
  return { text: parts.join(" · "), tone };
}

// ---- The critical banner ----------------------------------------------------

/// The sentence the pressure banner carries, or null when there is
/// nothing to raise.
///
/// Only at CRITICAL. Warn pressure already shows in the fleet strip's
/// tone and holds launches quietly; a banner at warn would be up half
/// the time on a busy machine, which is how a banner stops being read.
///
/// It names what gavin's own agents hold rather than the machine's
/// total, because that is the part the human can act on -- and because
/// the two buttons under it (open the sessions panel, close idle tabs)
/// only reach gavin's own.
export function pressureBannerLine(input: {
  pressure: MemoryPressure;
  agents: number;
  agentBytes: number;
}): string | null {
  if (input.pressure !== "critical") return null;
  const held =
    input.agents > 0
      ? `${input.agents} ${input.agents === 1 ? "agent holds" : "agents hold"} ${formatGb(input.agentBytes)}`
      : "gavin is running no agents";
  return `Memory is critical: ${held}. New launches are held.`;
}
