---
name: gavin-develop
description: Use when told to develop a gavin card — a To Do card that is one line of intent and has to become work an agent can execute. Interview the human first; write nothing to the card until they approve.
---

# Developing a card into a plan

A card in **To Do** is usually the one sentence the human had time to
type. Developing it turns that sentence into work an agent can execute
without guessing — and the guessing is the whole risk: whatever you do
not ask, you will invent, and the human finds out when the work comes
back wrong.

You are not doing the work here. You shape the card, and you stop.

## 1. Read before you ask

Never open with a question the repo already answers. Read, in this
order:

1. **The card** — its body, its parent, its children. The human's own
   words are the brief; keep them.
2. **The PRD** (`gavin_read_prd`) — the card has to trace back to it. A
   card that does not is itself the first question.
3. **The board** (`gavin_get_tree`) — the neighbouring cards. Work that
   overlaps a card already on the board is a question, not a plan. Ask
   `gavin_find_cards` with the card's intent as the `query` too: it reaches
   the archive, where the same work may already have been done.
4. **The code the card names.** A card that says "fix the login flow"
   has a login flow sitting in the repo. Read it.

Arrive at the interview with a draft you would defend.

## 2. Interview

One question at a time, and only what you could not read:

- **Done** — what will the human look at to call this finished?
- **Out of scope** — the neighbouring thing you must NOT touch.
- **Constraints** — which surfaces may change, what must keep working,
  what the human already decided and does not want re-litigated.
- **Unknowns** — anything nobody knows yet, which wants a spike as its
  own first step rather than a guess buried in step four.
- **Order** — anything that has to land before the rest.
- **Difficulty** — how much reasoning the work needs, when reading the
  code did not already settle it. Ask about the level you are unsure
  between, not about the scale: "this looks moderate to me — is there
  something subtle here I have not seen?"

Offer concrete alternatives rather than open questions: "A or B — I'd
take A because …" is answered in one word. Stop when the answers stop
changing the plan.

If the human hands it back — "you decide" — stop asking and propose the
draft with its assumptions named in it. An unanswered question becomes a
stated assumption, never a silent one.

### With Matt Pocock's skills: grill-with-docs

Look at your own skill list before the first question. If this workspace
has Matt Pocock's skills — `grilling` and `domain-modeling` among the
skills you can load (Claude Code lists them under the `mattpocock-skills`
plugin, other agents read them from wherever their skills live) — run
this interview as **grill-with-docs**.

That skill is one line: load `grilling` and `domain-modeling`. Load those
two yourself rather than `grill-with-docs`, which is marked for the human
to invoke and so is usually missing from your list; its two halves are
the whole of it. What it changes here:

- **The interview takes grilling's form**: rounds over the design tree,
  each round the whole frontier, numbered, each with your recommended
  answer — in place of one question at a time. The topics above are
  still what the tree has to cover by the time the frontier is empty;
  grilling decides their order.
- **domain-modeling writes as things resolve**: a term into `CONTEXT.md`,
  a decision that passes all three of its ADR gates into `docs/adr/` —
  or where the repo's `CONTEXT-MAP.md` sends them. Those are the only
  writes the interview makes before approval. They are the repo's
  vocabulary, never the card: the card is still proposed whole and
  written only after yes.
- **An empty frontier ends this step, not the session.** Go on to choose
  the shape and propose it. Do not follow grill-with-docs into `to-spec`,
  `to-tickets` or `implement`, its usual next steps: here the developed
  card is the spec, and running it is the human's call.

If the two skills are not there, interview as above. Do not install
them, and do not mention them.

## 3. Choose the shape, and say why

**A checklist** (`- [ ]` items in the body) when the steps are one
agent's work in order, sharing one context: each item is a few edits and
a way to tell it worked.

**Nested task cards** when the pieces each want their own agent and their
own session. Each child is `kind: task`, `parent: <this card's file
name>`, and **no** `status:` line.

**Both** is normal: a checklist whose one heavy item is a child card.

**Neither** when the interview says this is one sitting of work: nothing
to tick, nothing a second agent could take. Then developing it means
rewriting the body until an agent does not have to guess, and the card is
finished when it reads as an instruction. Small is a legitimate finding.
Padding it into five checklist items so the work looks developed is not.

Between the first two the test is not size, it is separability. Two
pieces that would fight over the same files are checklist items, not
cards. A piece a different agent could pick up cold, tomorrow, is a card.

Name the shape you chose and why, so the human can overrule it in one
word.

### Items only a person can close

Two checklist items are not an agent's to tick, and they carry a marker
that says so. A decision surfaces in the workspace's **Decisions** tab
and a test in its **Review** tab, both under this card, and the human's
reply is written back under the item —
`Answer (date): …`, `Result (date): passed`, `Result (date): failed —
<what went wrong>`.

- `- [ ] Decision: <question>` — a choice the work cannot invent. Add an
  indented `Options: A) … B) …` line when there is a shortlist.
- `- [ ] Human test: <what to check>` — a check no suite can reach:
  another machine, a real install, whether the rendered surface looks
  right.

Write one only for what a person genuinely has to do. A question you
could have asked in the interview is not a `Decision:` item — ask it, and
write the answer into the plan as settled. A check the suites already
cover is not a `Human test:` — running it is the agent's job, and a card
padded with them is a backlog nobody asked for.

The agent executing this card can file more of them as it goes, with
`gavin_request_human(card, kind, text, options?)`; what you write here is
the set the interview already knows about.

### The shape is the `kind:`

"Is this big enough to be a plan?" has a mechanical answer: it is a plan
the moment developing gave it something to tick or something to
dispatch. Until then it is a task, however long the sentence got.

That is not bookkeeping. `kind:` is the switch that picks the prompt a
Run hands the agent. `kind: task` inlines the body verbatim — *you are
executing the task card at …*, then your words. Every other kind gets the
plan prompt instead: *read this file and execute that plan, work its
checklist top to bottom, tick items as you complete them, promote the
ones that need their own agent* — and the body is never inlined at all.
Board Run, run-in-the-main-agent and an orchestration rail step all read
that one line the same way.

So the shape decides the type, and switching it is part of writing the
plan rather than tidying up after it:

- **Checklist, children, or both → the card becomes `kind: plan`.** It
  has to. Only a plan can be a parent, so children written under a card
  still marked `kind: task` nest under nothing — they come out loose on
  the board wearing a broken mark, the orchestrator offers each as work
  of its own, and moving the card to the done column leaves them behind.
  And only a plan draws a checklist: the `3/7` chip and the tickable list
  are gated on the kind, not on the `- [ ]` lines, so a checklist written
  under `kind: task` is counted by the daemon and shown nowhere.
- **Neither → it stays `kind: task`.** Promoting it anyway is not
  harmless tidiness. The plan prompt does not inline the body, so the
  paragraph you spent the interview earning never reaches the agent —
  which is instead told to work a checklist that does not exist.

Two things to check before you touch the line. **An absent `kind:`
already means plan**, so a card without one needs no switch. And **never
switch a card that carries a `parent:`** — a plan cannot nest, so the
parser drops the link and flags the card, and a child you were only
developing pops out of the plan it belonged to.

### Nested, not loose

A child with no `status:` **nests**: it has no card of its own on the
board, it is drawn inside this plan's card, and it travels with this plan
— into `plans/done/`, into the archive, onto a rail. That last one is why
this matters beyond tidiness: on the Orchestration tab the **plan is the
unit of placement**, so a rail carrying it carries every nested child,
and the unplaced list does not offer the children separately.

Add a `status:` and the child stops being a child in every one of those
senses: its own card, its own column, its own row in the unplaced list,
its own status to keep current. Do that **only** when the human has said
this piece is scheduled on its own — separate rail, separate worktree,
separate life. Otherwise nest, so the plan they are looking at stays one
thing on the board.

Whichever you choose, `parent:` is the plan's **file name** (`auth.md`),
never a path, and the plan must be in the same context folder. A `parent:`
that resolves to nothing does not nest and does not error — the board
draws the card loose with a broken-parent mark, and the orchestrator
offers it as work of its own. Which is exactly the mess this section
exists to avoid.

### How the children run: `children:`

A plan with nested tasks can run them two ways. Without the line, Run
starts ONE agent on the plan, which works the children itself, inline. With
`children: sequence` (or `parallel`) the plan is an **Orchestrated plan**:
Run puts it on a rail of its own, each nested task runs as **its own
session** — one at a time in tree order, or all at once in one checkout —
and the plan's own session runs last, to integrate and verify.

So whenever developing gives a card nested tasks, propose the line with
them:

- **`children: sequence`** — the default. The tasks build on each other,
  or nobody has shown they do not.
- **`children: parallel`** — only when the tasks are genuinely independent
  of each other: different files, no task reading another's output. They
  share one checkout at the same time, so two that touch the same files
  collide.
- **No line** — only when the human wants one agent doing it all, or the
  children are too small to deserve a session each.

`gavin_promote_task` never sets it: promoting an item makes a nested task
and nothing more. If the plan should orchestrate its children, the line is
a write of its own.

A nested task of an Orchestrated plan finishes by **ticking its own line**
in the plan (`gavin_tick_item`), never by a status — so write each child's
prompt about the work, and leave the finishing to the prompt gavin wraps
around it.

### Rate it: `complexity:`

Every card you develop gets a `complexity:` line, and every child card
you create gets its own. The level is not a label — the human maps each
one to an agent and a model, so it is the line that decides what
executes the work. An unrated card runs the workspace's default agent,
which means the strongest model available spends a subscription window
on a rename, or a small model is handed the deep end.

Rate on DIFFICULTY — how much reasoning the work needs — not on size. A
long mechanical edit across twenty files is `simple`; three lines in a
scheduler nobody understands is `intricate`.

| level | what it means |
|---|---|
| `trivial` | A one-liner — a rename, a typo, a version bump. |
| `simple` | One file, one obvious change, nothing to work out. |
| `moderate` | A few files and some judgement, but the shape is clear. |
| `complex` | Cross-cutting work that needs a plan before any code. |
| `intricate` | Subtle, risky or unfamiliar — the deep end. |

The reading you did in step 1 is what you rate from: the level answers
"how hard is the code this touches", and you have just been in it. Two
things it is not. It is not the shape — a plan with six checklist items
can be six `simple` edits, and a one-line task can be `intricate`. And a
plan's own level is not the sum of its children: what the plan's agent
does is work the checklist and dispatch, so rate the plan on the
judgement THAT takes, and rate each child on its own work.

If the answer is genuinely "nobody can tell until someone looks", say so
and leave the card unrated rather than inventing a level. Unrated is a
real state — it runs the workspace's own agent — and a wrong level sends
the work to the wrong model silently.

## 4. Propose, then wait

Put the whole thing on screen exactly as you intend to write it — every
checklist item, every child card with its title and its prompt, the
`kind:` the card ends as when that changes, and the `complexity:` you
are giving the card and each child — and, when it has nested tasks, the
`children:` mode they run in. A type switch is one word to
overrule and invisible to catch later, so it is proposed, never assumed;
a level is one word to overrule and spends the human's model budget, so
it is proposed too.

**Nothing is written before you hear yes.** Not a scratch file, not the
first card "to save a round trip", not "I'll start item one while you
read". The one exception is grill-with-docs' glossary and ADRs, written
as they resolve; they never touch the card. If the human changes something, re-propose the changed version
rather than patching it silently.

## 5. Write it

In this order, because the `kind:` decides what the rest of it means:

- **The `kind:` line, when the shape changed it** — a card that gained a
  checklist or children becomes `kind: plan`; a card that gained only a
  sharper prompt stays `kind: task`. `gavin_set_plan_field` does not
  write `kind:`, so edit that frontmatter line yourself. Do it before
  you create any child, so nothing is ever loose, not even between two
  writes.
- **Checklist**: rewrite the body — the human's framing, then the items,
  one line each, each naming an outcome you can verify.
- **Sharper prompt**, when that was the shape: rewrite the body as the
  instruction itself. A task's body reaches its agent verbatim, so what
  you leave there is the whole brief — not notes about the brief.
- **The level**: `gavin_set_plan_field(path, "complexity", "<level>")`,
  in the spellings above. An empty value clears the line back to
  unrated, which is what "nobody can tell yet" is written as — never a
  guessed `moderate`.
- **Children**: `gavin_create_plan` with `kind: "task"`, `parent` set to
  this card's file name, no status, and the child's own `complexity`.
  A task's body IS the prompt its agent will execute: write it as an
  instruction, not as a note. Rate it in the same call — a child filed
  unrated and rated afterwards can be run in between, at the wrong
  agent.
- **How the children run**, when it has any and the human approved a
  mode: `gavin_set_plan_field(path, "children", "sequence")` (or
  `"parallel"`), after the children exist. Nothing else writes it —
  `gavin_promote_task` does not.
- **Then read it back** from the canonical parse: `gavin_find_cards` with
  this card's file name as `parent` lists its children, and `gavin_get_tree`
  shows the card itself. The card must come back the kind you meant,
  carrying the level and the `children:` mode you meant, and every child `kind: task` with this
  card's file name as its `parent`, no status, and its own level — a child
  missing from that list is a `parent:` that does not say what you meant.
  Nothing here fails loudly — a
  typo'd `parent:`, a stray `status:`, a level the daemon could not read
  and a parent left as `kind: task` all produce a plan that looks right
  in the file and comes apart on the board. Fix what the tree shows
  before you say you are done.

## 6. Stop

Leave the status alone. The card stays where it is, developed and ready
for the human to start; running it is their call, not yours. Say what
you produced, and end there — the first item is not yours to tick.
