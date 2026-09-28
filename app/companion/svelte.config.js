// The Companion web bundle: the Workstation's UI as a phone runs it (spec
// "The Workstation UI bundle", ADR 0005). A static build like the desktop's,
// for the same reason -- there is no server behind it, only the channel.
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
      // `$lib` IS the desktop's library. Every desktop module imports its
      // siblings as `$lib/<folder>/<name>`, so pointing the alias at the
      // same folder is what lets the bundle import them unchanged.
      lib: "../src/lib",
    },
    alias: {
      // The bundle's own code. Not under `$lib`, which is the desktop's.
      $companion: "src/companion",
      // The remote shim (ADR 0003). The desktop's `backend.ts` imports
      // `invoke` and its state modules import `listen`; resolving both to
      // the channel is the whole of how they run on a phone unchanged.
      "@tauri-apps/api/core": "src/companion/remote/core.ts",
      "@tauri-apps/api/event": "src/companion/remote/event.ts",
      // Not in the spec's list, and load-bearing: the desktop decides
      // which window runs a workspace's rails from the window's LABEL,
      // and with no Tauri window to ask it falls back to "main" -- the
      // label of the one window that does run them. See remote/window.ts.
      "@tauri-apps/api/window": "src/companion/remote/window.ts",
      // The plugins. Each is a native capability of the DESK's window,
      // and every line of their own JS ends at a native bridge this page
      // does not have -- so none of it ships. tauriModules.test.ts holds
      // this list to what the desktop's library actually imports.
      //
      // `openUrl` is one of the channel's own messages.
      "@tauri-apps/plugin-opener": "src/companion/remote/opener.ts",
      "@tauri-apps/plugin-notification": "src/companion/remote/plugins/notification.ts",
      "@tauri-apps/plugin-clipboard-manager": "src/companion/remote/plugins/clipboard.ts",
      "@tauri-apps/plugin-dialog": "src/companion/remote/plugins/dialog.ts",
      "@tauri-apps/plugin-os": "src/companion/remote/plugins/os.ts",
    },
  },
};

export default config;
