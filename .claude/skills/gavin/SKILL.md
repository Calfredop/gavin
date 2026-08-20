---
name: gavin
description: Use when working in this repository — it is a gavin workspace with a PRD, plan files, and a kanban board the human watches.
---

# Working in a gavin workspace

This repo is managed by gavin. The human sees your plans as cards on a kanban
board and your spawned sessions on an Agents page. Follow this workflow:

## 1. Read the PRD first

`gavin_read_prd` (or read `.gavin-root/PRD.md`). It is the lead document —
every piece of work should trace back to it.

## 2. Plan before coding

Before touching code, create a plan in the nearest context:
`gavin_create_plan` with `context_folder` (the repo root, or a folder
containing `.gavin`), a kebab-case `file_name`, a `title`, and optionally
`status`/`priority`/`body`. Plans are markdown files with frontmatter — you may
also author them directly:

    ---
    title: My plan
    status: To Do
    priority: medium
    ---
    # My plan
    ...

## 3. Keep status current

The board's COLUMN NAMES are the status vocabulary — check them with
`gavin_get_board`. Update a plan as you work:
`gavin_set_plan_field(path, "status", "<column name>")` (matching is
case/spacing-insensitive: "In Progress" == "in-progress"). Do this when you
start, when you finish, and when you get blocked.

## 4. New feature or library? New context

`gavin_create_context(parent_folder)` scaffolds `.gavin/` there; its plans get
their own board for anyone working in that folder.

## 5. Parallel work: spawn visible sessions

`gavin_spawn_session(command, cwd?)` opens a terminal in the gavin app, visible
to the human on the Agents page. Never run long-lived background agents any
other way — visibility is the contract. (If a tool says the workspace isn't
open in gavin, ask the human to open it.)

## Notes

- `gavin_get_tree` is the canonical parse of every context and plan (statuses,
  warnings) — trust it over your own frontmatter parsing.
- After `gavin_init_root` in a fresh repo, reconnect MCP so the tools pick up
  the new root.
