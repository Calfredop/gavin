import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { svelteStyleCache } from "./vite-svelte-style-cache.js";
import { devCspMirror } from "./vite-dev-csp.js";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Before sveltekit(), because the warm half has to reach load() first
  // and the guard half has to reach it last -- see the file for what a
  // cold CSS cache does to the app.
  plugins: [svelteStyleCache(), sveltekit(), devCspMirror()],
  test: {
    // `src-tauri` as well as `src`, non-recursively. The two build scripts
    // beside tauri.conf.json are shipping code -- stage-sidecars.mjs runs in
    // the release workflow and dev-sidecars.mjs in every dev start -- and
    // they had no test home, so the platform rules they encode were asserted
    // nowhere. Not recursive on purpose: `src-tauri/target` is a cargo tree.
    include: ["src/**/*.{test,spec}.ts", "src-tauri/*.{test,spec}.mjs"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
