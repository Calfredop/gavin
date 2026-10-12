// The Companion shell's own web layer: the Workstations hub (spec "The
// Companion shell", ADR 0005). A static build shipped inside the binary --
// the shell's Capacitor webview only ever shows what ships in it.
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/// Under vitest the style step is left out. vitest 1 runs its own vite 5,
/// whose config vite 6's `preprocessCSS` cannot read, so a component with
/// a `<style>` would not compile at all for a test that draws it
/// (surfaces/hub.test.ts draws the hub). The step changes nothing here:
/// there is no postcss config and no `<style lang>`. Through `globalThis`:
/// this file is type-checked without Node's types.
const vitest = Boolean(/** @type {any} */ (globalThis).process?.env?.VITEST);

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess({ style: !vitest }),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    files: {
      // The desktop's library, for its theme and its components: the shell
      // is styled the desktop's way (ADR 0002).
      lib: "../src/lib",
    },
    alias: {
      $shell: "src/shell",
      // The Companion web bundle's code. The shell reads the channel's
      // message set and hosts the Demo Workstation from the same files the
      // bundle is built from, so the two ends of the channel cannot drift.
      $companion: "../companion/src/companion",
    },
  },
};

export default config;
