// How the live app icon moves: what the fleet's state maps to, and the
// math of the CRT-punch easter egg. Pure -- no canvas, no clock, no
// randomness of its own -- so the timing is testable; appIconCanvas.ts
// draws with it and LiveAppIcon.svelte drives it.
//
//   idle     still
//   working  wall glyphs re-roll, faster with more agents at work
//   waiting  an amber block cursor blinks after the G: >G█
//   failed   now and then one row garbles red and fades
//   paused   the wall goes grey and freezes; the carved >G stays
//
// States combine. A double click thumps the tube like an old CRT.
import { hash } from "./appIcon";

export interface IconStatus {
  /// Agents working right now, fleet-wide.
  working: number;
  /// Anything in the "waiting on you" inbox.
  waiting: boolean;
  /// Any agent stopped on a failure.
  failed: boolean;
  /// Any workspace held by a pause or a usage limit.
  paused: boolean;
}

export const ICON_IDLE: IconStatus = { working: 0, waiting: false, failed: false, paused: false };

/// The hub's own figures, folded to what the icon shows. The inbox and the
/// tallies are the hub's, so the icon can never disagree with the rows
/// under it.
export function fleetIconStatus(input: {
  running: number;
  failed: number;
  inbox: number;
  paused: number;
}): IconStatus {
  return {
    working: input.running,
    waiting: input.inbox > 0,
    failed: input.failed > 0,
    paused: input.paused > 0,
  };
}

/// The calm states' frame rate. A punch draws every display frame.
export const CALM_FPS = 15;

/// Wall cells re-rolled per second for each working agent, up to a cap so
/// a busy fleet shimmers rather than boils.
export const REROLLS_PER_AGENT = 9;
export const MAX_REROLL_AGENTS = 12;

/// Re-rolls owed after `dt` ms, carrying the fraction to the next frame.
export function rerollsDue(debt: number, working: number, dtMs: number): { count: number; debt: number } {
  const owed = debt + (Math.min(working, MAX_REROLL_AGENTS) * REROLLS_PER_AGENT * dtMs) / 1000;
  const count = Math.floor(owed);
  return { count, debt: owed - count };
}

/// A freshly re-rolled glyph lands bright and settles over this long.
export const FLASH_MS = 450;

export function flashAlpha(alpha: number, sinceMs: number): number {
  if (sinceMs < 0 || sinceMs >= FLASH_MS) return alpha;
  return alpha + (1 - alpha) * (1 - sinceMs / FLASH_MS);
}

export const CURSOR_BLINK_MS = 550;

export function cursorOn(nowMs: number, reduced: boolean): boolean {
  return reduced || Math.floor(nowMs / CURSOR_BLINK_MS) % 2 === 0;
}

/// How often a failed fleet glitches a row, give or take 30%, and how long
/// the red takes to fade.
export const GLITCH_EVERY_MS = 2600;
export const GLITCH_MS = 520;

export const AMBER = "#e8b04a";
export const RED = "#ff5c5c";
export const PAUSED_GREY = "#8d8e96";
export const PAUSED_ALPHA = 0.85;

// ---- the punch ------------------------------------------------------------

export const DOUBLE_CLICK_MS = 400;
export const PUNCH_MS = 2000;
/// How fast the shake dies away.
const DECAY_MS = 420;
/// The ring of the struck tube: one period of its wobble.
const RING_MS = 150;
const ATTACK_MS = 60;
/// A second blow adds to what is left, up to this.
export const MAX_PUNCH = 1.6;

export function isDoubleClick(lastClickMs: number | null, nowMs: number): boolean {
  return lastClickMs !== null && nowMs - lastClickMs < DOUBLE_CLICK_MS;
}

/// 0 when settled. A smoothstep ease-in over the first 60 ms -- so the blow
/// lands rather than pops -- then an exponential fade, cut at PUNCH_MS.
export function punchEnvelope(sinceMs: number, power: number): number {
  if (sinceMs < 0 || sinceMs >= PUNCH_MS) return 0;
  const a = Math.min(1, sinceMs / ATTACK_MS);
  return power * a * a * (3 - 2 * a) * Math.exp(-sinceMs / DECAY_MS);
}

/// The power of a blow landing while `left` of the last one remains.
export function nextPunchPower(left: number): number {
  return Math.min(MAX_PUNCH, left + 1);
}

/// The whole tube's jolt, as shares of its side: one damped oscillation,
/// mostly sideways, a little vertical out of phase.
export function ringOffset(sinceMs: number, hit: number): [number, number] {
  const ring = (2 * Math.PI * sinceMs) / RING_MS;
  return [Math.sin(ring) * hit * 0.03, Math.sin(ring * 0.7 + 1.2) * hit * 0.01];
}

/// Cheap smooth noise: incommensurate sines, roughly in [-1, 1].
export function wave(x: number, seed: number): number {
  return (
    (Math.sin(x * 1.3 + seed * 12.9) + Math.sin(x * 2.9 + seed * 7.3) * 0.5 + Math.sin(x * 0.7 + seed * 3.1) * 0.4) /
    1.9
  );
}

/// A row's sideways slide, in cells: a slow wave travelling down the tube,
/// plus one band of rows that slides much further and sweeps top to
/// bottom. Smooth in both row and time, so nothing jitters.
export function rowTear(row: number, rows: number, sinceMs: number, hit: number): number {
  if (hit <= 0) return 0;
  const phase = row * 0.45 - sinceMs * 0.012;
  const bandCentre = ((sinceMs * 0.03) % (rows + 8)) - 4;
  const band = Math.exp(-(((row - bandCentre) / 2.2) ** 2));
  return (wave(phase, 1) * 0.7 + band * 2.4 * Math.sin(sinceMs * 0.05)) * hit;
}

/// Static changes about twelve times a second, not every frame.
export const STATIC_TICK_MS = 80;

/// A stable value in [0, 1) per (x, y, tick), so static holds still
/// between ticks instead of flickering.
export function staticAt(x: number, y: number, tick: number): number {
  return hash(x, y, tick + 101);
}

export const NOISE_GLYPHS = "#%@&$*+=-:;!?/\\|<>[]{}~^01";
