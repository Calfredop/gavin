import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// No package.json beside this file, on purpose. Everything here resolves
// from `app/node_modules` by walking up, so the bundle is built with the
// desktop's own svelte and the desktop's own lockfile -- the two must be
// one commit (ADR 0005), and a second dependency tree is a second version.
// It also keeps vite-plugin-svelte crawling the desktop's dependency list,
// which is how it learns that `@lucide/svelte` ships uncompiled components.
export default defineConfig(async () => ({
  plugins: [sveltekit()],
  test: {
    // `check-install.mjs` beside this file as well: it runs before every
    // build, and is a node script, outside what svelte-check reads.
    include: ["src/**/*.{test,spec}.ts", "*.{test,spec}.mjs"],
    // Vitest empties every stylesheet it is not told to process, `?raw`
    // too. A stylesheet read as text is a guard's subject (the floor
    // under every field, seam/fieldFontSize.test.ts), so those come
    // through; one imported for its styles still compiles to nothing.
    css: { include: [/\.css\?raw$/] },
  },
  clearScreen: false,
  server: {
    // Beside the desktop's 1420/1421, never on them: `tauri dev` insists
    // on its port and fails when it is taken.
    port: 1430,
    strictPort: true,
    fs: {
      // The desktop's library and the shared node_modules both sit one
      // level up, outside this project's root.
      allow: [".."],
    },
  },
  preview: {
    port: 1431,
    strictPort: true,
  },
}));
