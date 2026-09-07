import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { svelteStyleCache } from "./vite-svelte-style-cache.js";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Before sveltekit(), because the warm half has to reach load() first
  // and the guard half has to reach it last -- see the file for what a
  // cold CSS cache does to the app.
  plugins: [svelteStyleCache(), sveltekit()],
  test: {
    include: ["src/**/*.{test,spec}.ts"],
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
