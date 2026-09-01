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

**Nested task cards** when the pieces are independently dispatchable —
each wants its own agent, its own session, its own status, maybe its own
worktree. Each child is `kind: task`, `parent: <this card's file name>`,
and **no** `status:` line; a status makes it a free-standing card
instead of a child.

**Both** is normal: a checklist whose one heavy item is a child card.

The test is not size, it is separability. Two pieces that would fight
over the same files are checklist items, not cards. A piece a different
agent could pick up cold, tomorrow, is a card.

Name the shape you chose and why, so the human can overrule it in one
word.

## 4. Propose, then wait

Put the whole thing on screen exactly as you intend to write it — every
checklist item, every child card with its title and its prompt.

**Nothing is written before you hear yes.** Not a scratch file, not the
first card "to save a round trip", not "I'll start item one while you
read". If the human changes something, re-propose the changed version
rather than patching it silently.

## 5. Write it

- **Checklist**: rewrite the body — the human's framing, then the items,
  one line each, each naming an outcome you can verify.
- **Children**: `gavin_create_plan` with `kind: "task"`, `parent` set to
  this card's file name, no status. A task's body IS the prompt its
  agent will execute: write it as an instruction, not as a note.
- **The card itself becomes `kind: plan`** — both shapes belong to a
  plan. This is load-bearing for children: the board marks the children
  of a task card broken, and moving that card to the done column leaves
  them behind. `gavin_set_plan_field` writes only status, priority and
  order, so edit the `kind:` line in the frontmatter yourself.

## 6. Stop

Leave the status alone. The card stays where it is, developed and ready
for the human to start; running it is their call, not yours. Say what
you produced, and end there — the first item is not yours to tick.
