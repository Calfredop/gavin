// The phone's text size setting, as the page's type scale.
//
// The pages size their type in `rem` on a 16px root (phone.css), and a
// fixed root ignores the text size a person picks in iOS's Settings:
// measured on an iPhone 16 Pro at the largest accessibility size, nothing
// on either webview moved. WKWebView follows Dynamic Type only for text
// that asks for a system style, so a probe asks for one --
// `font: -apple-system-body` -- and reads what it came out at: 17px at
// iOS's default size, 14px at the smallest, 28px at the first
// accessibility size and 53px at the largest (iOS 27 Simulator). Its
// ratio to 17 is `--text-scale` on the root, which phone.css multiplies
// the root by, so every `rem` and `em` follows.
//
// WebKit restyles a system font the moment the setting changes, so the
// probe's box changes size and a ResizeObserver hears it: the scale
// follows without a restart. No native code is involved, which is why it
// works the same in the hub and in a bundle's bridge-less webview.
//
// Where `-apple-system-body` means nothing -- Android, a desktop browser
// running the Demo -- the scale stays 1. Android's WebViews take the
// system font scale through their text zoom, which the shell sets
// natively (MainActivity, BundleActivity).
import { writable, type Readable } from "svelte/store";

/// iOS's body text at its default text size ("Large"), in px.
export const BODY_PX_AT_DEFAULT = 17;

/// The terminal grows with the text, up to this: past twice its size a
/// phone's width holds fewer than about 25 columns, and a full-screen
/// program on the Workstation, laid out for the PTY's width, stops
/// fitting at all.
export const TERMINAL_SCALE_MAX = 2;

/// What a system body size of `bodyPx` makes of the page's type, or 1
/// where the size is not one.
export function scaleFor(bodyPx: number): number {
  if (!Number.isFinite(bodyPx) || bodyPx <= 0) return 1;
  return Math.round((bodyPx / BODY_PX_AT_DEFAULT) * 1000) / 1000;
}

/// The terminal's font size at a text scale: never smaller than the
/// desk's own size, never more than TERMINAL_SCALE_MAX of it.
export function terminalFontSize(base: number, scale: number): number {
  return Math.round(base * Math.min(Math.max(scale, 1), TERMINAL_SCALE_MAX));
}

const scale = writable(1);

/// The scale in force, for what sizes itself in script (the terminal).
export const textScale: Readable<number> = { subscribe: scale.subscribe };

interface Probe {
  style: { cssText: string };
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

interface Observer {
  observe(target: Probe): void;
  disconnect(): void;
}

interface Scope {
  document: {
    documentElement: { style: { setProperty(name: string, value: string): void } };
    body: { appendChild(probe: Probe): void } | null;
    createElement(tag: "span"): Probe;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
  };
  getComputedStyle(probe: Probe): { fontSize: string };
  CSS?: { supports(property: string, value: string): boolean };
  ResizeObserver?: new (callback: () => void) => Observer;
}

/// Hidden, out of the flow, and sized by nothing but the system style.
const PROBE_STYLE =
  "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;font:-apple-system-body";

/// Keeps `--text-scale` on the root, and `textScale`, at what the phone's
/// text size makes of the type. Returns its own teardown.
export function followTextScale(scope: Scope = globalThis as unknown as Scope): () => void {
  const { document } = scope;
  if (!scope.CSS?.supports("font", "-apple-system-body") || !document.body) {
    scale.set(1);
    return () => {};
  }
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = PROBE_STYLE;
  probe.textContent = "M";
  document.body.appendChild(probe);

  const sync = (): void => {
    const next = scaleFor(parseFloat(scope.getComputedStyle(probe).fontSize));
    document.documentElement.style.setProperty("--text-scale", String(next));
    scale.set(next);
  };
  sync();
  const observer = scope.ResizeObserver ? new scope.ResizeObserver(sync) : null;
  observer?.observe(probe);
  // In case a change lands while WebKit is not laying the page out: the
  // setting is changed in another app, or under Control Center.
  document.addEventListener("visibilitychange", sync);
  return () => {
    observer?.disconnect();
    document.removeEventListener("visibilitychange", sync);
    probe.remove();
  };
}
