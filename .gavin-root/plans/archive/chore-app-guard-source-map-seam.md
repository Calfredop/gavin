---
kind: task
title: Give the static guard tests a source map that survives a move
parent: chore-app-lib-flat-directory.md
complexity: moderate
---
About 60 test files in `app/src/lib` read their subject's **source text** rather
than its exports, building the map with `import.meta.glob` over the flat
directory:

```ts
const SOURCES = import.meta.glob("./*.{svelte,ts}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}
```

Patterns in use across the tree: `"./*.svelte"` (86 hits), `"./*.ts"` (12),
`"./*.{svelte,ts}"` (12), plus `"../routes/*.svelte"`, `"../**/*.svelte"`,
`"./wizardSteps/*.svelte"` and single-file globs.

The flat glob is exactly what moving a file into a subfolder breaks. Most of
these guards would throw `no source for X` and fail loudly — acceptable. But
four sweep the whole map instead of naming a file:
`absolutePaneMount.test.ts`, `settingsSearchSurfaces.test.ts`,
`tooltipSurfaces.test.ts`, `terminalPaneSession.test.ts`. Those iterate
`Object.entries(SOURCES)` and assert a property of every entry, so a glob that
suddenly matches five files instead of two hundred **passes green over almost
nothing**. A silent guard is worse than a deleted one: it keeps the reviewer's
confidence while covering nothing.

Build the seam first, so the reorganization has something to move against.

**Do this:**

1. Add `app/src/lib/sources.ts` (not a `.test.ts` — the guards import it) that
   globs recursively once, e.g. `import.meta.glob("./**/*.{svelte,ts}", { query:
   "?raw", import: "default", eager: true })`, and exports:
   - `source(name: string): string` — resolves a **bare** name (`"BoardCard.svelte"`,
     `"cardDetail.ts"`) to its entry at any depth, throwing on a miss and
     throwing distinctly on an ambiguous basename, so two `index.ts`-shaped
     collisions surface as an error rather than a coin flip.
   - `sourcesMatching(pred)` / `allSources()` for the sweeping guards, returning
     entries keyed by bare name.
2. Exclude what the recursive glob newly picks up that the flat one never did:
   `.svelte-kit/`, `fixtures/`, and the `*.test.ts` files themselves — a guard
   that asserts over test files as well as sources will start failing on its own
   siblings' text.
3. Add a **floor assertion** in `sources.test.ts`: the map must hold at least ~450
   entries and at least ~100 `.svelte` files. This is the tripwire that makes a
   broken glob fail instead of pass. Set the numbers from what the map actually
   returns, rounded down — not from this card.
4. Rewrite every `import.meta.glob` in `app/src/lib/**/*.test.ts` onto the seam.
   Leave the globs that deliberately reach outside lib alone
   (`../routes/*.svelte`, `../../src-tauri/src/*.rs`,
   `../../src-tauri/tauri.conf.json`, `../../src-tauri/capabilities/default.json`,
   `../../../src-tauri/icons/icon.svg`,
   `../../../.claude/skills/gavin-develop/SKILL.md`) — those already name a path
   that the lib reorganization does not move.
5. Prove the sweepers still bite. For each of the four, temporarily narrow the
   seam's glob so it returns a handful of files and confirm the test **fails**;
   restore it. Report which four you proved and what the failure said.

**Verify:** `cd app && npm test && npm run check`. No file moves in this commit —
if `git status` shows a rename, it does not belong here.
