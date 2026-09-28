// The Companion shell's own web layer: the Workstations hub (spec "The
// Companion shell", ADR 0005). A static build shipped inside the binary --
// the shell's Capacitor webview only ever shows what ships in it.
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
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
