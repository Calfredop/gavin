import { describe, it, expect } from "vitest";

// The window's corners, on the two platforms that shape them differently.
//
// macOS rounds the NATIVE surface: mac_window.rs masks the NSWindow's
// content layer to a radius, and the shell (`.app` in +page.svelte)
// clips itself to the same radius so what it paints ends where the
// layer does. Windows shapes the window itself -- DWM rounds a floating
// top-level window at its own, smaller radius and squares it once it is
// maximized, snapped or full-screen -- and the WebView under the shell
// paints white wherever the shell does not. So a CSS radius there is
// never right: wider than DWM's arc it leaves a white crescent in each
// corner, and on a maximized window it leaves four white corners. The
// shell clips its corners only where the native layer under it is
// clipped to the same value, and that is macOS.
//
// Source text rather than the rendered DOM, for the reason
// appHeader.test.ts gives: a component <style> is compiled away, so the
// declarations are only legible here.

const PAGE = (
  import.meta.glob("../routes/+page.svelte", { query: "?raw", import: "default", eager: true }) as
    Record<string, string>
)["../routes/+page.svelte"];

const RUST = import.meta.glob("../../src-tauri/src/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const LIB_RS = RUST["../../src-tauri/src/lib.rs"];

/// The declarations of one rule, by exact selector -- the same crude
/// "text between this selector's braces" parse windowControls.test.ts
/// uses, which holds because none of these rules sits inside an at-rule.
function rule(source: string, selector: string): Record<string, string> {
  const style = /<style[^>]*>([\s\S]*)<\/style>/.exec(source);
  const css = (style ? style[1] : source).replace(/\/\*[\s\S]*?\*\//g, "");
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  const body = css.slice(at + selector.length + 2, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const colon = decl.indexOf(":");
    if (colon === -1) continue;
    out[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
  }
  return out;
}

/// The radius lib.rs asks mac_window.rs for, and only under the macOS
/// cfg: that gate is what makes the shell's own clip a macOS-only rule.
function nativeRadius(): number {
  const call =
    /#\[cfg\(target_os = "macos"\)\]\s*if let Some\(window\) = app\.get_webview_window\("main"\) \{\s*mac_window::round_window_corners\(&window, (\d+(?:\.\d+)?)\);/.exec(
      LIB_RS
    );
  expect(call).not.toBeNull();
  return Number(call![1]);
}

describe("the shell's corners", () => {
  it("are not clipped on every platform", () => {
    // Off macOS the OS shapes the window and the shell fills it edge to
    // edge; any radius here would show the WebView's white.
    expect(rule(PAGE, ".app")).not.toHaveProperty("border-radius");
  });

  it("are clipped to the native layer's radius, and only where there is one", () => {
    expect(rule(PAGE, ".app.rounded-corners")["border-radius"]).toBe(`${nativeRadius()}px`);
    // The class comes from the same platform question the corner's
    // controls do -- and the other way round from them.
    expect(PAGE).toMatch(/<div\s+class="app"[^>]*class:rounded-corners=\{isMacSync\(\)\}/);
  });
});
