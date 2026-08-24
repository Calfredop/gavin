---
title: Orchestration tools — build
status: Done
---
Implementation checklist for [Add orchestration tools](add-orchestration-tools.md).
Design: `docs/superpowers/specs/2026-08-21-orchestration-tools-design.md`.

- [x] Protocol: `ToolDef`, `Step.toolId`/`toolParams`, `GetTools`/`SaveTool`/`DeleteTool`/`GetToolsByRoot`, `Tools` response
- [x] Daemon: `orch_tools` table, `orch_steps` ALTER-TABLE migration, tool CRUD + server routing
- [x] Tauri: `get_tools` / `save_tool` / `delete_tool` commands + `backend.ts` mirrors
- [x] `orchestrationTools.ts`: types, the 10 built-ins, `resolveToolBody`, placeholder scan, library merge (+ tests)
- [x] `orchestration.ts`: tool steps in `Step`, mutators, scheduler completion by exit code, conflicts (+ tests)
- [x] `layoutState.ts`: record session exit codes for the scheduler
- [x] `toolsState.ts` + `orchestrationState.ts`: tool store, launch a tool step, tool step actions
- [x] Drag: `"tool"` drag kind through `orchestrationDrag.ts` and the glue (+ tests)
- [x] UI: drawer Tools section, tool step chip, `ToolLibraryDialog`, `StepParamsDialog`
- [x] MCP: tools in `gavin_get_orchestration`, step shapes in `gavin_set_orchestration`, orchestrate skill
- [x] Full test + build sweep (`cargo test --workspace`, `npm test`, `svelte-check`)
