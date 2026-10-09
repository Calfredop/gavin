import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// Only Capacitor is installed beside this file (see package.json); svelte,
// kit and vite resolve from `app/node_modules` by walking up, so the hub is
// compiled by the same svelte as the desktop components it draws.

/// The shell has no Tauri. A desktop module that reaches for it belongs to
/// a Workstation, and a Workstation's UI is the bundle's to run -- so an
/// import of one is a build error here, not a runtime surprise on a phone.
/** @returns {import("vite").Plugin} */
function noTauri() {
  return {
    name: "companion-shell:no-tauri",
    enforce: "pre",
    /**
     * @param {string} id
     * @param {string | undefined} importer
     */
    resolveId(id, importer) {
      if (id.startsWith("@tauri-apps/")) {
        this.error(`${importer ?? "?"} imports ${id}: the Companion shell has no Tauri`);
      }
      return null;
    },
  };
}

/// Through `globalThis`: this file is type-checked without Node's types.
const e2e = Boolean(/** @type {any} */ (globalThis).process?.env?.GAVIN_E2E);

export default defineConfig(async () => ({
  plugins: [noTauri(), sveltekit()],
  test: {
    // The scripted pairing against a real daemon runs only when asked
    // for (`scripts/pair.sh node`): it needs the daemon and the Relay built.
    include: e2e ? ["src/**/*.e2e.ts"] : ["src/**/*.{test,spec}.ts"],
    // Compiled, not handed to Node: a test that draws the hub draws the
    // bundle's header, and its icons are `.svelte` files. The desktop's
    // suites find the library in their own package.json; this folder's
    // lists only Capacitor.
    server: { deps: { inline: [/@lucide\/svelte/] } },
    // Vitest empties every stylesheet it is not told to process, `?raw`
    // too: the spacing scale in phone.css is a guard's subject
    // (surfaces/spacing.test.ts), as it is in the bundle's suites.
    css: { include: [/\.css\?raw$/] },
  },
  clearScreen: false,
  server: {
    // Beside the desktop's 1420/1421 and the bundle's 1430/1431.
    port: 1440,
    strictPort: true,
    fs: {
      // The desktop's library, the bundle's code and the shared
      // node_modules all sit one level up.
      allow: [".."],
    },
  },
}));
