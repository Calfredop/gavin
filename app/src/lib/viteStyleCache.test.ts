import { describe, it, expect } from "vitest";
import { isSvelteStyleModule, svelteStyleCache } from "../../vite-svelte-style-cache.js";

// The hooks as this test drives them: vite's own Plugin["load"] is a
// union with an object form, and calling it with a stub context through
// that union says nothing useful about what broke.
type Hook = {
  name: string;
  enforce: string;
  apply: string;
  load: (this: { warn: (message: string) => void }, id: string) => unknown;
};
const hooks = () => svelteStyleCache() as unknown as Hook[];

/* What this pins is the SHAPE OF THE ID, because that is the half that
   can rot silently. If vite or vite-plugin-svelte ever spells a style
   request differently, the matcher stops matching, both hooks pass, and
   the dev server goes back to answering with the raw `.svelte` file --
   whose `<style>` block WebKit then applies to the whole app, unscoped.
   Nothing fails; a component somewhere just starts wearing another
   component's rules. */

const STYLE_ID = "/repo/app/src/lib/CardDetailModal.svelte?svelte&type=style&lang.css";

describe("isSvelteStyleModule", () => {
  it("matches the style module a browser actually asks for", () => {
    expect(isSvelteStyleModule(STYLE_ID)).toBe(true);
  });

  it("lets everything else through untouched", () => {
    // The component itself, its script half, and the `?raw` reads the
    // surface tests do (appHubSurface.test.ts and friends glob source as
    // text) all have to reach their normal loaders.
    expect(isSvelteStyleModule("/repo/app/src/lib/Modal.svelte")).toBe(false);
    expect(isSvelteStyleModule("/repo/app/src/lib/Modal.svelte?svelte&type=script")).toBe(false);
    expect(isSvelteStyleModule("/repo/app/src/lib/Modal.svelte?raw")).toBe(false);
    expect(isSvelteStyleModule("/repo/app/src/lib/theme.css")).toBe(false);
  });
});

describe("svelteStyleCache", () => {
  it("is two hooks, one either side of vite-plugin-svelte's load", () => {
    // The warm half has to run BEFORE the svelte plugin's load so the CSS
    // it compiles is there to be found; the guard half has to run AFTER
    // it, and after every other plugin, so the only hook left below it is
    // vite's fs fallback -- the one that serves the raw file.
    const [warm, guard] = hooks();
    expect(warm.enforce).toBe("pre");
    expect(guard.enforce).toBe("post");
    expect(warm.apply).toBe("serve");
    expect(guard.apply).toBe("serve");
  });

  it("answers a cold cache with an empty stylesheet, never the file", () => {
    const [, guard] = hooks();
    const warnings: string[] = [];
    const css = guard.load.call({ warn: (m) => void warnings.push(m) }, STYLE_ID);
    expect(css).toBe("");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("CardDetailModal.svelte");
  });

  it("does not answer for anything that is not a style module", () => {
    const [, guard] = hooks();
    expect(guard.load.call({ warn: () => {} }, "/repo/app/src/lib/Modal.svelte?raw")).toBe(null);
  });
});
