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

If your own CLI mints its own conversation id, rather than one gavin
fixed for you at launch, pass it the moment you have it as
`gavin_name_session`'s second, optional argument:
`gavin_name_session(name, agent_conversation_id)`. Gavin stores it so a
later Resume can reopen this exact conversation instead of writing a
fresh one from an account of it. Only call it with a real id your CLI
actually handed you — nothing to pass otherwise, and most CLIs need
nothing here at all.

## 1. Read the PRD first

`gavin_read_prd` (or read `{prd}`). It is the lead document —
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

**Nesting travels.** A nested task has no card of its own anywhere: it moves
into `plans/done/` with its parent, archives with it, and on the Orchestration
tab it rides inside its parent's step — the plan is the unit a rail places, so
nested children are not offered for placement separately. Only a **plan** can
be a parent, and `parent:` is a file name in the same context folder; a
`parent:` that resolves to anything else leaves the card loose on the board
with a broken mark rather than erroring.

## 4. Keep status current

The board's COLUMN NAMES are the status vocabulary — check them with
`gavin_get_board` (columns + label vocabulary). Update cards as you work:
`gavin_set_plan_field(path, "status", "<column name>")` (matching is
case/spacing-insensitive; an empty value removes the line — that is how a
task returns to nesting). Do this when you start, finish, or get blocked. If
a human ran your card, the app already set it In Progress — you set the done
column when finished. Labels: `gavin_set_plan_field(path, "labels", "bug,
ui")` referencing the board's label names.

**In Progress claims the card for your tab.** A card in that column belongs
to the session that put it there: the board shows your session instead of a
Run button, so nobody starts a second agent on work already under way. That
is why the status write belongs at the START of the work and not only at the
end — and why a card someone else is working is not yours to move there.

A card set to **Done** is filed under `plans/done/` — that keeps the plans
folder to the work still in flight — and taking it off Done brings it back.
The reply names the card's path after the write, so when it moved, use the
new path from then on. Nested children travel with their parent.

## 5. When only a person can answer

Some work stops on a human, not on a command: a choice that is not yours
to make, or a check no suite can run. File it on the card with
`gavin_request_human(card, kind, text, options?)`, then carry on with
everything that does not depend on it — the tool returns as soon as the
line is written, and the answer arrives on the card later.

- **`kind: "decision"`** — a question whose answer is words: which
  approach, which name, whether to go ahead. Pass `options` when there is
  a shortlist; each becomes a button the human can press.
- **`kind: "test"`** — a check only a person can run: another machine, a
  real install, whether the rendered surface actually looks right.

It writes `- [ ] Decision: <question>` or `- [ ] Human test: <what to
check>` into the card's checklist — with an indented `Options: A) … B) …`
line when you passed options — and the item appears in the workspace's
**Decisions** tab under that card. Filing one claims the card for your
session, exactly like setting it In Progress.

The answer comes back **under the item, on the card**: `Answer (date): …`
for a decision, `Result (date): passed` or `Result (date): failed —
<what went wrong>` for a test. A failed test keeps its box unticked and
is yours again. Once you have fixed what they found, ask for it again
with **word-for-word the same text**: an identical re-file re-arms that
item rather than filing a second one.

Do not use it for anything you could settle by reading the repo or
running a command, and never sit waiting on it — there is no blocking
form. If the work genuinely cannot go on without the answer, file the
question, say so, and stop.

## 6. New feature or library? New context

`gavin_create_context(parent_folder)` scaffolds `.gavin/` there; its cards
get their own board for anyone working in that folder.

## 7. Parallel work: spawn visible sessions

`gavin_spawn_session(command, cwd?)` opens a terminal in the gavin app,
visible to the human on the Agents page. Never run long-lived background
agents any other way — visibility is the contract. (If a tool says the
workspace isn't open in gavin, ask the human to open it.)

## 8. Proposing a memory

Learned something durable about this repo that no card records — a trap, a
convention, a command that only works one particular way? File it as a
**memory**: `kind: note`, `labels: memory`, and a body of one sentence-sized
fact plus an optional `Why:` line. The body IS the fact; nothing else belongs
in it.

```
---
kind: note
title: The daemon is shared
labels: memory
---
Never pkill gavin-daemon.

Why: every other session loses its PTYs with it.
```

You are proposing, not deciding. The human adopts it from the card's detail
modal — "Adopt into CLAUDE.md" (or whichever instructions file this workspace
uses) — which appends the body under a `### Learned` heading inside that file,
where every future agent reads it, and files the card done. Nothing is adopted
automatically, so keep each memory to one fact worth carrying.

## Notes

- `gavin_get_tree` is the canonical parse of every context and card (kinds,
  statuses, parents, checklist counts, warnings) — trust it over your own
  frontmatter parsing.
- After `gavin_init_root` in a fresh repo, reconnect MCP so the tools pick up
  the new root.
