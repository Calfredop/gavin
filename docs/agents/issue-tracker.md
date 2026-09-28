# Issue tracker: gavin cards

Issues and specs for this repo live as gavin cards: markdown files with a YAML header, kept in `.gavin-root/plans/`. Done cards move to `plans/done/`; archived ones move to `plans/archive/` and leave the board. The human watches the cards on the kanban board. The card model is described in `.claude/skills/gavin/SKILL.md`. Prefer the `gavin_*` MCP tools, and write the file by hand only when the tools are unavailable.

## Conventions

- **A card is one `.md` file.** Its header fields:
  - `kind`: `note`, `task` or `plan`
  - `title`
  - `status`: a board column name, such as `To Do`, `In Progress` or `Done`
  - `priority`
  - `labels`: comma-separated
  - `parent`: a plan's file name, in the same folder

  The body is the prompt or description. Checklists are `- [ ] item`.
- **A task with `parent:` and no `status:` nests inside its plan and takes the plan's status.** A ticket that must be worked on its own needs its own `status:`.
- **Specs:** the full text goes in `docs/superpowers/specs/<YYYY-MM-DD>-<slug>.md`. A `kind: plan` card summarises the spec and links to it.
- **Blocking:** the first line of the body is `Blocked by: <card>.md, <card>.md`. A card is unblocked once every card it lists is Done. Rails (the `gavin-orchestrate` skill) sequence cards so they respect these edges.
- **Triage state:** a label in the `labels:` field (see `triage-labels.md`). `gavin_set_plan_field` cannot write labels, so edit the `labels:` header line directly, and keep a card's existing labels when adding one.
- **Comments:** append them, dated, at the bottom of the body under a `## Comments` heading.
- **Questions or checks only a person can answer:** `gavin_request_human(card, "decision" | "test", text)`.

## When a skill says "publish to the issue tracker"

- **A spec:** write `docs/superpowers/specs/<date>-<slug>.md`, then `gavin_create_plan` with `kind: plan` and `status: To Do`, and a body that summarises and links the spec.
- **A ticket:** `gavin_create_plan` with:
  - `kind: task`
  - `parent: <plan file>`
  - `status: To Do`
  - a body that is a self-contained prompt, whose first line is `Blocked by:` when the ticket has blockers.

  Neither `gavin_create_plan` nor `gavin_set_plan_field` takes labels, so add the `labels:` header line by editing the file.

## When a skill says "fetch the relevant ticket"

Read the card file; `gavin_get_tree` resolves names to paths. Read its parent plan and the linked spec too, when they exist.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a plan card, and each **child** is a task card nested under it.

- **Map:** a `kind: plan` card labelled `wayfinder:map`. Its body holds the Notes, Decisions so far and Fog.
- **Child ticket:** a `kind: task` card with:
  - `parent: <map file>`
  - `status: To Do`
  - the label `wayfinder:<type>`, where the type is `research`, `prototype`, `grilling` or `task`
  - the question in the body.
- **Blocking:** the `Blocked by:` line, as above.
- **Frontier:** the map's children that are in To Do and unblocked. The first in board order (`order:`) wins.
- **Claim:** set the status to In Progress (`gavin_set_plan_field`) before doing any work.
- **Resolve:** append the answer under an `## Answer` heading and set the status to Done. Then append a pointer (the gist and a link) to the map's Decisions so far.
