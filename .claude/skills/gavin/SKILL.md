---
name: gavin
description: Use when working in this repository — it is a gavin workspace with a PRD, card files, and a kanban board the human watches.
---

# Working in a gavin workspace

This repo is managed by gavin. Every card on the human's kanban board is a
markdown file in a `.gavin*/plans/` folder; your spawned sessions appear on an
Agents page. Follow this workflow:

## 0. Name your tab, first thing

You are running in a tab the human is watching, next to every other
agent's tab. Before you read anything else, call
`gavin_name_session(name)` with **two to four words for the work**, not
for yourself: "login flow", "git tab conflicts", "kanban drag bug".
Un-named tabs all show the same folder name, and a page of them is
unreadable. Re-name yourself if the work turns into something else.

## 1. Read the PRD first

`gavin_read_prd` (or read `.gavin-root/PRD.md`). It is the lead document —
every piece of work should trace back to it.

## 2. Cards: note, task, plan

Create cards with `gavin_create_plan` (`context_folder`, kebab-case
`file_name`, `title`, optional `status`/`priority`/`body`/`kind`/`parent`) or
author the file directly. `kind` picks what the card IS:

- **note** — a reminder; title (+ optional body).
- **task** — one unit of agent work; **the body is the prompt**. A human may
  run your card with the workspace agent at any time.
- **plan** (the default) — multi-step work; the body holds ordinary markdown
  checklists (`- [ ] step`).

```
---
kind: task
title: Fix the login flow
parent: auth-rework.md
---
The exact prompt an agent should execute.
```

**Plan before coding**: create a plan card in the nearest context before
touching code, work its checklist top to bottom, and tick items (`- [x]`) as
you complete them — the tick is the completion marker the board's progress
counts.

## 3. Nesting and promotion

A **task with `parent: <plan-file>` and NO `status:` nests inside that plan's
card** on the board. Give it a status and it becomes a free-standing card in
that column (the parent link stays). When a checklist item needs its own
agent or status, promote it: `gavin_promote_task(plan_path, item)` creates
the nested task and rewrites the item into a link — when that task completes,
tick the original item.

## 4. Keep status current

The board's COLUMN NAMES are the status vocabulary — check them with
`gavin_get_board` (columns + label vocabulary). Update cards as you work:
`gavin_set_plan_field(path, "status", "<column name>")` (matching is
case/spacing-insensitive; an empty value removes the line — that is how a
task returns to nesting). Do this when you start, finish, or get blocked. If
a human ran your card, the app already set it In Progress — you set the done
column when finished. Labels: `gavin_set_plan_field(path, "labels", "bug,
ui")` referencing the board's label names.

A card set to **Done** is filed under `plans/done/` — that keeps the plans
folder to the work still in flight — and taking it off Done brings it back.
The reply names the card's path after the write, so when it moved, use the
new path from then on. Nested children travel with their parent.

## 5. New feature or library? New context

`gavin_create_context(parent_folder)` scaffolds `.gavin/` there; its cards
get their own board for anyone working in that folder.

## 6. Parallel work: spawn visible sessions

`gavin_spawn_session(command, cwd?)` opens a terminal in the gavin app,
visible to the human on the Agents page. Never run long-lived background
agents any other way — visibility is the contract. (If a tool says the
workspace isn't open in gavin, ask the human to open it.)

## Notes

- `gavin_get_tree` is the canonical parse of every context and card (kinds,
  statuses, parents, checklist counts, warnings) — trust it over your own
  frontmatter parsing.
- After `gavin_init_root` in a fresh repo, reconnect MCP so the tools pick up
  the new root.
