---
name: gavin-orchestrate
description: Use when the human asks to organize, plan, order, parallelize, or reorganize this workspace's work — or asks why a rail is blocked. Reads and writes the Orchestration tab's rails, cutting the worktrees and branches they need.
---

# Organizing a gavin workspace's work into rails

The Orchestration tab lays this workspace's cards out in time. A **rail**
is a vertical track bound to a git checkout and a workspace page. A rail
holds ordered **stages**; a stage holds one or more **steps**. Stages run
one after another. **A stage's steps run at the same time, in that rail's
checkout.**

A step is one of two things, never both:

- a **card step** (`cardPath`) — an agent runs that card, and the step is
  done when the card reaches the board's done column;
- a **tool step** (`toolId` + `toolParams`) — a reusable unit of work
  from the workspace's tool library: an agent prompt, a bash command, or
  a bash script. It is done when its session exits 0, and stalled on any
  other exit. One tool, `Start rail`, is an action gavin performs itself
  and finishes instantly — see §2a.

The human arms a rail with Start; gavin then launches each stage and
advances when every step in it is done.

## 1. Read before you write

Call `gavin_get_orchestration` first, every time. It returns the current
rails with their worktrees, branches and **uncommitted files**, every step
with its card or tool and live run state, the board's columns, every
runnable card not yet on a rail, and the **tool library** with each
tool's parameters. Never author an arrangement from memory or from the
card titles alone.

If there are no rails yet, create one per natural workstream — a
subsystem, a layer, a piece of the PRD — and give each one the isolation
it needs (§2b). Cutting that worktree or branch is your job, not a note
for the human: a rail nobody bound is a rail that cannot run beside
another.

## 1a. What you were asked to change

The tab has two buttons that call you, and the request says which:

- **Organize with agent…** (the tab header) — the job is the cards
  **nobody has placed**: the `unplacedCards` list in the read payload. The
  request names them too, but cuts a long backlog and says so — the
  payload is the complete list. Put every one of them on a rail — extend a rail
  where the work belongs on one, add a rail where it does not (§2b for
  its isolation). Steps already on rails stay where they are unless a
  card you are placing forces a reorder, and then say which and why.

  Pressing it is also a request to **parallelize**: the human wants this
  backlog running at once, not queued. Answer it with rails, and cut the
  worktrees they need — §2's "spread it wide".

  Placing is not only cards, either: add a tool step — one of this
  workspace's own or one of gavin's built-ins (§2a) — anywhere a rail
  needs a boundary a card cannot give it, a commit or a test run before
  or after the cards you are placing.
- **Reorganize with agent** (a wand in ONE rail's header) — the job is
  that rail's own arrangement: reorder its stages, split a stage whose
  steps would collide in one checkout, merge stages that are genuinely
  independent. Keep the steps it already holds — that button is not the
  place to add or drop work — and leave every OTHER rail exactly as you
  read it.

A request that names neither is the human asking in their own words:
then the whole orchestration is yours.

Either way you still send the **whole plan** back (§4) — the scope is
what you may CHANGE, not what you write. A rail you were not asked about
goes back with the same ids, the same stages and the same `toolId` /
`toolParams` it arrived with.

## 1b. A plan carries its nested children

A card can NEST inside another: `kind: task`, `parent:` naming a plan's
file name, and **no `status:` line of its own**. Such a child has no card
of its own on the board — it is drawn inside the plan's card, and so it
rides inside the plan's card step on a rail. The agent that runs the plan
works its children.

So the **plan is the unit of placement**, and `unplacedCards` does not
list nested children at all. Neither should your arrangement:

- **One step per plan, never one step per nested child.** A plan and a
  child of it on rails are the same work scheduled twice; gavin flags it
  as a `nested-with-parent` conflict.
- A piece that genuinely wants a rail of its own — its own agent, its own
  worktree, its own status on the board — is not a nested child. It needs
  a `status:` of its own, which makes it free-standing. That is an edit
  to the card, so say so and let the human make it; do not work around it
  by placing the nested child.

A card with `parent:` **and** a status is free-standing already: it sits
in its own column, `unplacedCards` lists it, and you place it like any
other card. Its plan being on a rail says nothing about it.

## 2. The parallelism rule

Two steps collide only when they edit the **same working tree**:

- **Same rail, same stage** — always the same checkout. There is no
  step-level worktree, so co-staging two steps means two agents editing
  one tree at once. Only do this when the work genuinely does not touch
  the same files.
- **Different rails on different worktrees** — never a conflict, whatever
  they touch. Worktree isolation is the answer.
- **Different rails on the SAME worktree** — always a risk: rails advance
  independently, so gavin makes no ordering promise between them.
- **Different stages of one rail** — strictly sequential, never a
  conflict.

Weigh the card bodies and the rail's `dirtyPaths` before co-staging
anything. **When unsure, serialize.** A wrong serial order costs time; a
wrong parallel one costs a merge conflict in a live checkout, and the
human has to untangle two agents' half-finished edits.

If two pieces of work must run at once and might collide, the right move
is two rails on two worktrees — not one parallel stage.

### Spread it wide

"When unsure, serialize" is a rule about a **stage**, and it is not
licence to answer an **Organize** run with one long rail. That button is
the human asking for their backlog to run at once; an arrangement that
queues every card behind a single checkout hands them back the
arrangement they already had.

So default the other way at the RAIL level. Two pieces of work that do
not depend on each other belong on **two rails with two worktrees**, not
in two stages of one — that is the arrangement that is both parallel and
safe, and the reason worktree isolation exists. Serialize *inside* a
rail; parallelize *across* rails; let the number of rails be the number
of independent workstreams the cards actually contain.

Cutting those worktrees is part of the answer, not a follow-up for the
human — §2b.

What still earns a sequence:

- a card that **cannot start until another finishes** — it edits what the
  other produces, or reviews it;
- work that is honestly the same files in the same checkout;
- a rail that must land before another begins: chain those with the
  `Start rail` tool (§2a) rather than trusting the timing.

Everything else runs beside it.

## 2b. Worktrees and branches are not the same tool

A rail carries two independent bindings: `worktreePath` says **which
checkout** its agents run in, and `branch` says **which branch gavin puts
that checkout on** before the rail's first step. A rail with a branch and
no worktree runs on that branch in the workspace's root checkout — a rail
per branch, with no folder per rail.

**A branch is not isolation.** A checkout can only be on one branch at a
time, so two rails sharing a checkout are exactly as dangerous as before
whether or not they name different branches — worse, in fact, because
they will fight over the head. Isolation comes from a separate worktree
and nothing else.

So choose:

- **a worktree** when rails must run **at the same time**, or when the
  work is long-lived enough to want its own files on disk. An Organize
  run is the first case by default (§2);
- **a plain branch** when the rails are alternatives the human will run
  **one at a time**, and a folder per rail would just be clutter.

Gavin switches a bound branch only when no step of that rail is running,
refuses while the checkout has uncommitted changes, and never switches
back when the rail completes — the work stays checked out, in view.

### Make the isolation, do not merely name it

You have a shell. **Create the worktree and the branch yourself**, then
send the rail back bound to them. A `worktreePath` nothing created does
not bind a rail — gavin flags it `worktree-missing` and every step on it
stalls — and a rail with neither binding is not isolated at all, however
the arrangement reads.

Work from the **workspace root**: the checkout you were launched in, and
the one every absolute card path in the read payload sits under.

1. **Look first.** `git worktree list` and `git branch`. A branch already
   checked out somewhere cannot be checked out again, and a folder that
   already exists is not yours to claim.
2. **A worktree on a new branch**, in the sibling folder gavin's own
   dialog would have proposed — the root's folder name, a hyphen, and the
   branch with each `/` written as `-`:

   ```
   git worktree add -b <branch> ../<repo>-<branch>
   ```

   An existing branch instead: `git worktree add <path> <branch>`.
3. **Then its setup.** `[worktree] setup` in `.gavin-root/config.toml`
   declares what a fresh checkout needs — `npm install`, `cargo fetch`, an
   `.env` copy. Gavin runs those for a worktree made in the app; nothing
   runs them for one made here, so run them yourself in the new checkout,
   joined with `&&` so a failed install stops the rest. A worktree whose
   setup failed is worse than no worktree: the rail's first agent looks
   like it started fine and spends its turn on the install.
4. **A branch with no worktree** is `git branch <name>` — created, never
   checked out. The rail's own first step is what moves a checkout, once,
   and the human is working in the root one meanwhile. Never
   `git checkout` in the root yourself.
5. **Then bind it in the write**: `worktreePath` and `branch` on the rail.
   Set both for a worktree you cut on a new branch — the switch is a
   no-op while the checkout is already there, and the pair is what the
   human and the next agent read as the rail's isolation.

Branch names have to survive git: no spaces, no `..`, no leading `-`, no
`.lock` tail, and none of `~ ^ : ? * [ \ @{`. Slug the rail's name into
one.

Never cut a second worktree or branch for a rail that already carries
one, and say in your summary which ones you created and where.

A tool step counts here exactly like a card step: a `Run tests` or
`Commit changes` step writes to the rail's checkout, so co-staging it
with anything else in that rail is the same hazard.

## 2a. Placing tools

Tools are how a rail finishes its own work rather than leaving it for the
human: a `Commit changes` after the cards that produced the diff, a
`Run tests` before it, a `Push branch` or `Send a notification` at the
end. Two catalogs feed a tool step, and both are yours to place from —
never invent a `toolId` outside either one:

- **This workspace's own**, custom-made tools — every entry the read
  payload's `tools` list carries, each already showing its `id`, `kind`
  and the parameters it takes. Pick these by that `id`.
- **Gavin's built-ins** — a fixed catalog every workspace has, whatever
  the read payload's `tools` list says. It never appears there (that
  list is only what a human authored), so it goes here instead:

  - `builtin:commit` — commits the checkout's uncommitted work in
    logical chunks; never pushes.
  - `builtin:consolidate-repo` — same, for a tree several agents share:
    commits per FEATURE, never `git add -A`.
  - `builtin:push` — pushes the checked-out branch, setting upstream on
    first push.
  - `builtin:merge` — merges another branch INTO this rail's checkout.
  - `builtin:merge-into` — lands this rail's branch on another one, run
    from the checkout that holds it.
  - `builtin:open-pr` — opens a pull request from the current branch
    (needs `gh`).
  - `builtin:run-tests` — runs the project's test command; done when it
    exits 0.
  - `builtin:until` — runs a check; on failure, sends the rail back to
    redo the step before it.
  - `builtin:await-pr` — waits on the rail's pull request (CI,
    optionally an approval); never merges.
  - `builtin:manual-review` — holds the rail for a human look; Skip
    sends it on.
  - `builtin:code-review` — reviews the branch's diff and files findings
    as cards; changes no code.
  - `builtin:reconcile-repo` — reports every branch and worktree against
    a base; reads only.
  - `builtin:notify` — a macOS notification.
  - `builtin:send-email` — sends through macOS Mail.app.
  - `builtin:browser-test` — drives the Claude-in-Chrome tools through a
    checklist against a URL.
  - `builtin:unity-tests` — runs a Unity project's tests in batch mode.
  - `builtin:start-rail` — arms another rail by name (see "Chaining one
    rail to the next" below).

  A built-in is placed exactly like a custom tool — same `toolId` field,
  same `toolParams` override shape, no card of its own — so treat the
  two catalogs as one list with two sources.

- Give a tool step its own stage unless you have a reason not to. Tools
  are usually the *boundary* between pieces of work, and a boundary that
  runs concurrently with the work is not a boundary.
- Override a parameter with `toolParams: { "name": "value" }` — the
  parameter names the payload lists for a custom tool, or the ones named
  above for a built-in. Omit a parameter to take the tool's own default —
  and prefer omitting, so a later edit to that default reaches the step.
- A tool step needs no `cardPath` at all. Sending both is refused.

### Chaining one rail to the next

`Start rail` is the tool for a dependency between rails: put it at the
**end** of the rail that must finish first, with
`toolParams: { "rail": "<the other rail's name>" }`. When the first rail
reaches it, the named rail arms itself — no human waiting for the first
to finish, and no session of its own.

Use it only for a real ordering constraint. Two rails that could run at
once should both just be started (§2c); chaining them serializes work the
whole tab exists to parallelize. And say in a `conflict_notes` entry which fact
made the second rail wait for the first.

It names the rail by NAME, so a rail you rename in the same write has to
be renamed in the parameter too. It refuses rather than guesses: an
unknown name, a name two rails share, the rail the step is itself on, and
a paused rail all stall the step.

## 2c. Arming a rail yourself

`gavin_start_rail({ rail: "<name>" })` arms a rail exactly as the human's
Start button does: gavin runs it from its **first unfinished stage**, on
the rail's own page. Use it when the human asked you to get work moving,
not only to arrange it.

**Never write run state to the daemon socket yourself.** A `SetRailRun`
row written by hand names no workspace, so gavin cannot tell the open app
about it — the rail sits armed in the database and idle on screen — and
nothing computes the stage or checks what the rail is doing first.

It decides before it writes, and says which happened:

- **refuses** a name no rail carries, a name two rails share, and a
  **paused** rail — a pause is the human's or a stalled step's, and
  resuming it would re-launch the step that failed. Fix the cause and
  tell them; Resume is theirs to press.
- **leaves alone**, and says so, a rail that is already running (starting
  it would REWIND it to its first unfinished stage) and one with nothing
  unfinished left. Neither is an error.

Start the rails a change actually makes runnable, one call each, and say
which you started. A rail chained behind another with the `Start rail`
tool step (§2a) arms itself when the first finishes — do not also start
it by hand.

## 3. Record your reasoning

Every judgement you made goes back as a `conflict_notes` entry naming the
step ids it concerns. The human reads these in the tab's Conflicts box,
beside gavin's own structural findings. An arrangement with no notes asks
to be trusted blindly; one with notes can be checked.

## 4. Write it

`gavin_set_orchestration` replaces the whole plan.

- **Preserve the ids** of steps you are keeping. Run state follows the
  step id, so a new id silently discards which agent is on which work.
- **Carry `toolId` and `toolParams` through** on every tool step you are
  keeping. A rewrite that drops them turns a tool step into a step that
  is neither a card nor a tool, and the daemon refuses the whole write.
- **Never remove a step whose `run` is `running`.** The daemon refuses
  the whole write and tells you which step — moving it between stages or
  rails is fine, only deleting it is not.
- Positions are yours to set; keep them dense and ascending.

Then say what you changed and why, in a sentence or two per rail.

## 5. When a rail is stuck

A card step shows `stalled` when its agent exited before the card reached
the done column, or when its card or worktree went missing. A tool step
shows `stalled` when it exited non-zero, when gavin was not running to
see it exit, or when its tool has been deleted from the library.

Read the cause, fix it, and tell the human — Retry is theirs to press,
not yours.
