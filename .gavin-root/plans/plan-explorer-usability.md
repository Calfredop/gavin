---
title: Plan explorer usability (outside contexts, delete, menu, format help)
status: Done
priority: medium
labels: ui
---
# Plan explorer usability

Five gaps in the Plans tab: contexts outside the workspace are rejected
instead of shown; the file composer can't be closed with the mouse; files
can't be deleted; no contextual menu; the gavin file formats are
undiscoverable.

- [x] Protocol: `GavinContext.outside` flag; `AddExternalGavinContext` /
      `RemoveExternalGavinContext` requests; bump PROTOCOL_VERSION to 8
- [x] Daemon: `extra_contexts` array in `.gavin-root/config.toml` — scan_root
      appends existing outside contexts (deduped, never for folders under the
      root); add/remove requests scaffold + edit config via toml_edit; tests
- [x] Daemon: relax the card-delete guard to also allow `.md` files (nested
      ok) under `.gavin*/docs/` and `.gavin*/specs/`; `..` segments refused;
      tests
- [x] Bridge: tauri commands + backend.ts wrappers + gavin.ts type
- [x] Explorer tree: `outside` carried onto nodes, outside contexts sorted
      last, orange name, hover tooltip "outside workspace — path"; `+
      context` on an outside folder registers it instead of erroring
- [x] Composer: visible ✕ close button (Escape already works)
- [x] Contextual menu component + wiring: file rows (Open / Open beside
      terminal / Delete…), context rows (New plan/doc/spec…, Remove from
      navigator for outside), group rows (New file…)
- [x] Delete flow: ConfirmPrompt; plans reuse the cascade (deletionPlanFor /
      executeDeletion), docs/specs delete directly; refresh tree after ops in
      outside contexts (no watcher there)
- [x] Format help: "?" in the sidebar head opens a cheatsheet modal (note /
      task / plan frontmatter, checklists, docs & specs conventions)
- [x] cargo test (98+174+7+32) + vitest (472) + svelte-check (0 errors, no
      new warnings) pass
