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
   overlaps a card already on the board is a question, not a plan.
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

Offer concrete alternatives rather than open questions: "A or B — I'd
take A because …" is answered in one word. Stop when the answers stop
changing the plan.

If the human hands it back — "you decide" — stop asking and propose the
draft with its assumptions named in it. An unanswered question becomes a
stated assumption, never a silent one.

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

## 4. Propose, then wait

Put the whole thing on screen exactly as you intend to write it — every
checklist item, every child card with its title and its prompt, and the
`kind:` the card ends as when that changes. A type switch is one word to
overrule and invisible to catch later, so it is proposed, never assumed.

**Nothing is written before you hear yes.** Not a scratch file, not the
first card "to save a round trip", not "I'll start item one while you
read". If the human changes something, re-propose the changed version
rather than patching it silently.

## 5. Write it

In this order, because the `kind:` decides what the rest of it means:

- **The `kind:` line, when the shape changed it** — a card that gained a
  checklist or children becomes `kind: plan`; a card that gained only a
  sharper prompt stays `kind: task`. `gavin_set_plan_field` writes status,
  priority and order only, so edit the frontmatter line yourself. Do it
  before you create any child, so nothing is ever loose, not even
  between two writes.
- **Checklist**: rewrite the body — the human's framing, then the items,
  one line each, each naming an outcome you can verify.
- **Sharper prompt**, when that was the shape: rewrite the body as the
  instruction itself. A task's body reaches its agent verbatim, so what
  you leave there is the whole brief — not notes about the brief.
- **Children**: `gavin_create_plan` with `kind: "task"`, `parent` set to
  this card's file name, no status. A task's body IS the prompt its
  agent will execute: write it as an instruction, not as a note.
- **Then read it back.** `gavin_get_tree` is the canonical parse: the
  card must come back the kind you meant, and every child `kind: task`
  with this card's file name as its `parent` and no status. Nothing here
  fails loudly — a typo'd `parent:`, a stray `status:` and a parent left
  as `kind: task` all produce a plan that looks right in the file and
  comes apart on the board. Fix what the tree shows before you say you
  are done.

## 6. Stop

Leave the status alone. The card stays where it is, developed and ready
for the human to start; running it is their call, not yours. Say what
you produced, and end there — the first item is not yours to tick.
