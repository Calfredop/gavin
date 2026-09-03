# Orchestration Tools — Design Spec

Steps on an orchestration rail can currently only be **cards**. This adds
**tools**: reusable, parameterised units of work the human drops into a rail
between cards — commit, push, merge, run tests, notify — each of which is an
**agent prompt**, a **bash command**, or a **bash script**. Ten ship built in;
the human creates more, per workspace or shared across every workspace.

Extends `2026-08-21-orchestration-tab-design.md`; every decision there still
holds unless restated here.

**Out of scope:** conditional steps ("only if the previous one failed"),
tool output captured into gavin, tools that read the rail's run state, tool
versioning, and sharing tools between machines.

*"Tools that read the rail's run state" was narrowed on 2026-09-02: §8 adds
one that WRITES it, and still nothing that reads it.*

---

## Decisions

| # | Decision |
|---|---|
| T1 | A step is a reference to **a card OR a tool** — never both. `toolId` set means a tool step; `cardPath` is `""` there. |
| T2 | A tool's **body is text**, and its `kind` says how to run it: `agent` (prompt for the workspace's agent), `command` (a shell command line), `script` (a multi-line bash script). |
| T3 | Tools take **string parameters** substituted into the body as `{{name}}`. Substitution is **literal** — the tool author owns the quoting. Each step carries its own overrides. |
| T4 | Tools live in **three scopes**: `builtin` (shipped, read-only, TypeScript constants), `global` (this machine, every workspace), `workspace` (this workspace only). A workspace tool wins a name clash. |
| T5 | A tool step is **done when its session exits 0**, stalled on any other exit — including an exit gavin did not witness. There is no card and therefore no done column to reach. **Amended 2026-08-25:** true for `command` and `script` tools only. An `agent` tool's session never exits, so it is done when **its turn ends** — see §3.1. |
| T6 | A tool step runs in **the rail's checkout** (`worktreePath ?? tree.rootPath`), so it participates in `same-worktree` conflicts exactly like a card step. `duplicate-card` never fires for tools — two `Push` steps are correct. |
| T7 | Built-ins are **data, not code**: a `BUILTIN_TOOLS` array in `orchestrationTools.ts`, unit-tested like any other pure module. Nothing about running them is special-cased. |
| T8 | The plan is still replaced **wholesale**; tools are a **separate, targeted store** (upsert/delete by id), because a tool outlives every arrangement that uses it. |
| T9 | **Added 2026-09-02:** a fourth kind, `gavin`, is an action **the app performs itself** — no session, no checkout, no exit code. Built-in only, and its **body names the action** so it stays data (T7) rather than a branch on an id. One ships: `builtin:start-rail`. See §8. |
| T10 | **Added 2026-09-03:** two more kinds, and both exist because a **completion rule** is what a kind is for. `until` runs a check and, when it fails, sends the rail **backwards** over the step before it, up to a budget. `pr` runs nothing at all: it waits on the pull request for the rail's branch, which gavin reads with `gh` host-side, and reaches the same verdict from GitHub. Both are built-in only. See §9. |

---

## 1. Data model

### 1.1 Tool

```ts
export type ToolKind = "agent" | "command" | "script" | "gavin";
export type ToolScope = "builtin" | "global" | "workspace";

export interface ToolParam {
  /// `{{name}}` in the body. [A-Za-z_][A-Za-z0-9_]*
  name: string;
  label: string;
  default: string;
}

export interface Tool {
  /// Built-ins use "builtin:<slug>"; the rest are UUIDs.
  id: string;
  name: string;
  description: string;
  kind: ToolKind;
  body: string;
  params: ToolParam[];
  scope: ToolScope;
}
```

`scope` is **derived, not stored**: the daemon stores `workspace_id`
(`NULL` = global) and the app labels the row. Built-ins never reach the
daemon at all.

`gavin` was added by §8. `TOOL_KINDS` — what the library dialog's chips
offer — stays the three **authorable** kinds; the fourth is built-in only.

### 1.2 Step

```ts
export interface Step {
  id: string;
  position: number;
  /// "" for a tool step.
  cardPath: string;
  toolId: string | null;
  /// Overrides only; a param the human never touched is absent and the
  /// tool's own default is used at launch.
  toolParams: Record<string, string>;
}
```

`cardPath` stays a non-null `String` on the wire and in SQLite. `""` is
unambiguous (card paths are absolute) and it costs no table rebuild, no
wire break, and no change to the running-step guard's message.

### 1.3 SQLite

`orch_steps` gains two columns, added idempotently by `ALTER TABLE` after
`PRAGMA table_info` — the store is already live on the human's machine, so
`CREATE TABLE IF NOT EXISTS` alone would silently keep the old shape:

```sql
ALTER TABLE orch_steps ADD COLUMN tool_id TEXT;
ALTER TABLE orch_steps ADD COLUMN tool_params TEXT;   -- JSON object, defaults to {}
```

One new table:

```sql
CREATE TABLE IF NOT EXISTS orch_tools (
  id TEXT PRIMARY KEY,
  -- NULL means global: every workspace on this machine sees it.
  workspace_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL,          -- agent | command | script
  body TEXT NOT NULL,
  params TEXT NOT NULL,        -- JSON array of ToolParam
  position INTEGER NOT NULL
);
```

`replace_plan`'s orphan sweep is untouched. A step referencing a **deleted**
tool is *not* refused — the plan is the human's, and the step stalls at
launch with `tool is no longer in the library`, which is a message rather
than a lost arrangement.

---

## 2. Daemon and protocol

| Request | Response | Notes |
|---|---|---|
| `GetTools { workspace_id }` | `Tools { tools }` | This workspace's tools **plus** every global one. Never an error. |
| `SaveTool { tool, workspace_id }` | `Ok` | Upsert by id. `workspace_id: None` stores it global. Changing scope is a re-save with the other value. |
| `DeleteTool { id }` | `Ok` | By id alone; ids are UUIDs. |
| `GetToolsByRoot { root_path }` | `Tools { tools }` | For the MCP server, resolving root → watcher → workspace like `GetBoardByRoot`. |

`ToolDef` on the wire carries `workspace_id: Option<String>`; the app maps
`Some` → `workspace`, `None` → `global`. Tool writes do **not** push: they
originate in the app that already holds the state, and the tab refetches
every loaded workspace after a write so a global tool appears everywhere.

---

## 3. Running a tool step

`executeLaunch` branches once, on `step.toolId`.

**Resolve** the tool from the library (built-ins ∪ global ∪ workspace).
Missing → stall `tool is no longer in the library`.

**Substitute**: `resolveToolBody(tool, step.toolParams)` replaces every
`{{name}}` with the step's override, else the param's default, else `""`.
Unknown placeholders are left verbatim — silently blanking a typo would be
worse than a visible `{{brnach}}`.

**cwd** is `rail.worktreePath ?? tree.rootPath`. Not the card fallback:
there is no card. A rail with neither stalls with
`no worktree bound and the workspace has no root`.

**Command**, by kind:

| kind | session command |
|---|---|
| `agent` | `buildRunCommand(resolvedAgentFor(ws).command, body)` — the same path a card step takes |
| `command` | the body verbatim; the daemon already runs it as `sh -c <line>` |
| `script` | `bash -c <shellQuote(body)>` — a multi-line body under bash, not sh, so `[[`, arrays and `pipefail` behave as written |

`command` and `script` are additionally wrapped so a failure announces
itself on screen before the PTY closes:

```sh
<composed>
__gavin_code=$?
[ "$__gavin_code" -ne 0 ] && printf '\n[gavin] %s exited with code %s\n' <name> "$__gavin_code"
exit "$__gavin_code"
```

The session is named after the tool (`setSessionName`) so the tab is
identifiable while it runs.

**No card side effects**: no `linkCardSession`, no `In Progress` write.
A tool is not a card and has no status to keep.

### 3.1 Completion (T5)

`nextActions` gains one parameter, `exitCodes: Map<string, number>`, fed by
a new `sessionExits` store in `layoutState` — the `session-exited` listener
already receives `[id, code]` and threw the code away. It records the code
**before** calling `handleSessionExited`, so a tick triggered by the layout
change always sees it.

For a step whose session is no longer live:

| step | outcome |
|---|---|
| card | unchanged — done if the card reached the done column, else stalled |
| tool, exit `0` | `markDone` |
| tool, exit `n ≠ 0` | `stall` — `<tool> exited with code n` |
| tool, no code known | `stall` — `<tool>'s session ended while gavin was not watching` (the app restarted mid-run) |

Rule 1 (card reached the done column) is skipped entirely for tool steps.

### 3.1.1 Agent tools finish differently (amended 2026-08-25)

The table above cannot describe an `agent` tool, and shipping it that way
made all four agent built-ins — Commit, Merge, Browser test, Review this
branch — **unfinishable**. §3's command table sends an agent tool through
`buildRunCommand`, the interactive path, and an interactive agent never
exits: it finishes its turn and sits at its prompt forever, which is the
whole reason `buildHeadlessCommand` exists for the runs that must end. So
"exits 0" never came, the step stayed `running`, and since the daemon
refuses every plan write that drops a `running` step, the rail was wedged
shut — uneditable and undeletable until the human killed the session and
deleted the step by hand.

An agent tool step is therefore done when **its session goes `idle`**, the
same signal behind the "<label> finished" notification:

| session status | outcome |
|---|---|
| `idle` | `markDone` — the turn ended |
| `working` | keep running |
| `waiting_for_input` | keep running — the agent is ASKING, and advancing past a question would answer it by walking away. `pty.rs` pins `TERM_PROGRAM`, so an agent that wants attention says so rather than merely going quiet, and the daemon refuses to let a quiet period downgrade this to `idle`. |
| none reported | keep running — the daemon registers every new session `idle`, so an absent status is "nothing yet", not "finished" |

Only `agent` tools: a `command` tool's verdict stays its exit code, because
a quiet `npm run dev` is a server that started, not a step that finished.
And never a card step, whose completion is rule 1 — an agent that stopped
talking without finishing its card left the work undone, which is exactly
what rule 1 is there to catch.

Headless was the other candidate and was rejected: the only verified
headless argv is claude's, deliberately scoped to `Bash(git *)`, which
kills Browser test outright, stops Merge running the tests its own prompt
demands, and stalls all four tools under codex, gemini and cursor.

The scheduler gained a per-step escape hatch with it — **Mark done**, beside
Retry on any running or stalled step — so a completion signal that never
arrives costs one click rather than the session and the step.

---

## 4. Conflicts

`placedSteps` already keys `same-worktree` on the rail's checkout, so a tool
step joins those groups untouched (T6). Two changes only:

- `duplicate-card` groups by `cardPath` — tool steps are filtered out of
  that pass. Two `Push` steps in one rail are the normal case.
- `describeConflict` names a tool step by its tool name, falling back to the
  tool id, exactly as a card step falls back to its file name.

---

## 5. The tab

### 5.1 Drawer

A **Tools** section above the unplaced card groups, collapsible like a
status group, listing built-in, global and workspace tools with a kind icon
(`Bot` / `Terminal` / `FileCode2`). Rows are `[data-orch-tool]` — dragged
onto a rail exactly like a card, or clicked to append. A `Manage tools…`
row opens the library dialog.

`OrchDragKind` gains `"tool"`, whose `id` is the tool id. It commits into
`addToolAsStageAction` / `addToolToStageAction`, mirroring the card pair.
A tool dropped on the drawer is a no-op, like a card.

### 5.2 Tool step chip

The chip is now the **tool** step's shape alone: a card step renders the
kanban card itself (tab spec O14), and the dashed chip is what says a tool is
not a card.

A tool step renders the tool's kind icon, its name, and — when the tool
declares params — a `Sliders` button opening the params popover. Its
non-default params show as a muted one-line summary (`branch=develop`), so
two `Merge` steps on one rail are distinguishable without opening anything.

Everything else about the chip is unchanged: run-state ring, conflict
badges, retry, remove.

### 5.3 Library dialog

`ToolLibraryDialog.svelte` — one modal, two modes.

*List mode*: three sections (Built-in / This workspace / All workspaces).
Built-ins offer **Duplicate**; the others offer **Edit** and **Delete**.

*Edit mode*: name, description, kind (three radio chips), scope (This
workspace / All workspaces), body (a textarea; monospace for `command` and
`script`), and a params editor — rows of name/label/default with add and
remove. Beneath the body, a live list of the `{{placeholders}}` found in it,
flagging any that no param declares.

### 5.4 Step params dialog

`StepParamsDialog.svelte` — one input per declared param, placeholder
showing the tool default, and a **Reset to defaults**. Saving writes only
the values that differ from the default, so a later edit to the tool's
default still reaches steps that never overrode it.

---

## 6. MCP

`gavin_get_orchestration` gains a `tools` array (the whole library) and each
step gains `toolId`, `toolName` and `toolParams` beside `cardPath`. A step
is rendered by its tool name where it has one.

`gavin_set_orchestration`'s `rails` schema documents the two step shapes.
`protocol::Step`'s new fields are `#[serde(default)]`, so an agent that
writes the old shape still produces valid card steps — but one that
**re-writes** a rail must carry `toolId` through or it silently converts a
tool step into a broken card step. The orchestrate skill says so in a
sentence, and the tool list in the read payload is what makes placing a tool
possible at all.

---

## 7. The built-in set

Eleven tools, covering every example the card named and demonstrating all
three kinds. `{{param}}` defaults in brackets.

| id | name | kind | params |
|---|---|---|---|
| `builtin:commit` | Commit changes | agent | — |
| `builtin:push` | Push branch | command | `remote` [origin] |
| `builtin:merge` | Update from a branch | agent | `branch` [main] |
| `builtin:merge-into` | Merge this rail into a branch | agent | `base` [main] |
| `builtin:open-pr` | Open a pull request | command | `base` [main] |
| `builtin:run-tests` | Run tests | command | `command` [npm test] |
| `builtin:unity-tests` | Run Unity tests | command | `unity`, `project` [.], `platform` [EditMode], `results` [TestResults.xml] |
| `builtin:browser-test` | Browser test (Chrome) | agent | `url` [http://localhost:5173], `checks` |
| `builtin:code-review` | Review this branch | agent | `base` [main] |
| `builtin:notify` | Send a notification | command | `title` [gavin], `message` |
| `builtin:send-email` | Send an email (Mail.app) | script | `to`, `subject`, `body` |

`Merge` is an agent, not `git merge --no-edit`: a conflict left in a live
checkout is the worst failure this feature can produce, and an agent can
resolve it or abort cleanly. `Commit` is an agent for the message quality.
`Push`, `Open PR` and the two test runners are commands because their
success is exactly their exit code. `Send an email` is the script example.

`Send a notification` and `Send an email` are macOS-only (`osascript`), and
say so in their description — literal substitution (T3) means a `"` in a
message breaks them, which the dialog's help text states.

### 7.1 Merge ships in both directions (amended 2026-08-25)

The table shipped ONE merge, and it was the inbound one: "merge `{{branch}}`
into the branch checked out in this worktree". A tool step always runs in the
rail's own checkout (`executeToolLaunch`), so on a rail bound to a worktree
that tool pulls `main` in, and on a rail with none it merges `main` into
`main` — "Already up to date", exit 0, step done. Neither lands the rail's
work anywhere, which is what a step called *Merge a branch* sitting after
*Commit* and *Push* reads as.

No parameter value fixes it, because the landing direction is unreachable
from the rail's checkout at all: git refuses to check `main` out while
another worktree holds it (`fatal: 'main' is already used by worktree at …`),
and merging the rail's own branch into itself is a no-op. It has to run in
the checkout that HAS the base branch — `git -C <that checkout> merge <rail
branch>` — which is the move the Git tab's own merge-back already makes
(`gitState.mergeBack`, §3.4 of the worktrees spec: **root** cwd, not the
fork's).

So: `builtin:merge` keeps its id and its direction and is renamed **Update
from a branch** — existing steps keep working and now say what they do — and
**`builtin:merge-into` — Merge this rail into a branch** (`base` [main])
joins it. Its prompt refuses rather than improvises: it stops if the rail is
already on `base` (no branch of its own), stops if the rail's checkout is
dirty (uncommitted work does not travel with a merge), and if git refuses
because the base checkout has local changes it reports that verbatim and
stops — it never commits, stashes or discards work it did not write, since
that checkout is the human's and the stash stack is shared across every
worktree.

Renaming rather than flipping was deliberate: pulling `main` into a
long-running rail is a real operation the human already used, and flipping
`builtin:merge` would have changed the direction of every existing step
silently, under an unchanged name.

---

## 8. `gavin` tools: actions the app performs (added 2026-09-02)

`Start rail` is a step that arms **another rail** — how one rail's last
step unblocks the next, without a human watching for the first to finish.
None of the other three kinds can express it: it is not a prompt, not a
command line, and no shell reaches gavin's run state.
`gavin_set_orchestration` writes the *arrangement*, never `railRuns`, so
an agent tool could not do it either.

So a fourth kind (T9). `builtin:start-rail`, kind `gavin`, one param
`rail` with **no default** — a shipped rail name would arm somebody
else's rail.

### 8.1 The body names the action

A `gavin` tool's body is `start-rail`, and `gavinActionOf` reads it back.
Not a branch on the tool id, because that would make the built-in set
code again after T7 spent a spec making it data: the scheduler asks the
tool what it does, and an action this build does not implement stalls
with the body quoted — which is what makes a plan written by a NEWER
gavin diagnosable rather than mysterious.

`validateTool` refuses a `gavin` tool naming no action. Unreachable from
the dialog, which offers only the authorable three, but such a tool would
stall every step it was dropped onto with the mistake visible only at
launch. The dialog offers **no Duplicate** on one for the same reason:
its edit form has no chip that could express the kind.

### 8.2 It resolves in the launch, and never runs

`executeToolLaunch` branches on `tool.kind === "gavin"` **before**
resolving a checkout — a gavin action touches no worktree, and stalling
one on an unbound rail in a rootless workspace would be a refusal about
something it was never going to use.

The step goes straight from `pending` to `done` or `stalled`. It never
passes through `running`, which matters twice: there is no session for
T5's exit code or §3.1.1's idle status to speak for, and a step stuck
`running` wedges the rail shut (the daemon refuses every plan write that
drops a running step).

`done` is written **before** `startRail`. That call ticks, this
workspace's tick is already in flight, so it only queues a replay — which
re-reads this step and would launch it a second time if it were still
pending.

And the launch **asks for that replay itself**, through the same `again`
return `executeSwitchBranch` uses (`executeLaunch` and `executeToolLaunch`
return a boolean for it). Every other launch leaves a session behind, and
that session's exit or status is what ticks the scheduler afterwards; this
one starts none, and `orchestrations` is deliberately not a scheduler
input, so the `done` write raises nothing by itself. Without the return,
the rail would sit on a finished step until some unrelated event ticked —
and the two no-op verdicts, which never reach `startRail` at all, would
raise nothing whatsoever.

### 8.3 What it refuses, and what it shrugs at

`startRailVerdict` (pure, in `orchestration.ts`) decides. Names match
case- and space-insensitively: a human typed this into a parameter field,
and `"Deploy"` failing to match `"deploy "` would be a stall with no
visible cause.

| target | verdict | why |
|---|---|---|
| no name given | refuse | names the field, so the fix is one click away |
| no rail by that name | refuse | quotes the name |
| two rails by that name | refuse | rail names are not unique — nothing in `addRail` or `renameRail` makes them so — and starting an arbitrary one is worse than saying which fact is missing |
| the rail this step is on | refuse | arming it re-points that rail at the stage holding this very step: a loop with no exit |
| paused | refuse | a pause is a human's decision or a stalled step's consequence; resuming would re-launch the step that failed |
| already running | **no-op, done** | `startRail` re-points a rail at its FIRST unfinished stage, so this would REWIND it — the same exclusion `runnableIdleRails` makes for "Run all" |
| idle, nothing unfinished | **no-op, done** | there is no stage to arm; a finished rail is not a failure |
| idle, work left | **start** | |

The two no-ops are `done` rather than stalls, on the posture
`builtin:commit` already takes towards a clean tree: nothing to do is a
success, not a problem. Every refusal is a stall, so it lands on the chip
and rule 5 pauses the rail, exactly as a failed launch does.

### 8.4 Surfaces

A `Zap` icon in the drawer, the step chip and the library dialog;
`toolKindLabel` says **Gavin action**. `StepParamsDialog` cannot preview a
body that is not source, so it promises what the step will do instead —
*Start the rail "Deploy".* — and says plainly when no rail is named yet.

Conflicts are untouched: a `gavin` step joins `same-worktree` groups like
any other tool step (T6). That is a harmless over-report — it touches no
checkout — and handing `detectConflicts` the tool library to tell them
apart costs more than the false positive does.

---

## 9. `until` and `pr`: kinds that can move a rail backwards (added 2026-09-03)

Every kind before these answers one question — *is this step finished?* —
and the answer is yes or it is a stall. These two add a third answer: **do
it again.** A check that failed is not a reason to stop a rail, it is a
reason to re-run the work that failed it, and a rail that paused on every
red test would never retry anything.

That is a **completion rule**, and §3.1 already establishes that
completion rules live in the kind. So `until` is not a `command` with a
flag and `pr` is not a `gavin` action with a timer: a duplicate of either
— or one a newer gavin ships — loops because of what it IS, not because
the scheduler recognised an id.

`orchestrationLoop.ts` owns the loop for both. One budget (persisted on
the step's own run row, reusing `resumeAttempts`), one `loopBack` action,
one rule about what opens the re-run's prompt. The two kinds differ only
in **where the verdict comes from**.

### 9.1 `until` — the verdict is an exit code

`builtin:until` runs its check as a visible shell session on the rail's
page, tee'd to a file so the retry prompt and the stall reason can quote
it without depending on a terminal the human never opened.

### 9.2 `pr` — the verdict is GitHub

`builtin:await-pr` starts **no session**. `pull_request.rs` runs one `gh
pr view <branch> --json …` per minute per branch, and `pullRequest.ts`
turns that report into the same verdict `until` gets from an exit code:
pass, wait, loop back, give up.

**One poll, two readers**, and that is the whole reason the reading is
host-side rather than a `gh` in the step's own shell. The rail header's PR
chips are drawn from the same report the step's verdict comes from, so a
green chip row beside a waiting rail is not a state this can reach.

Three consequences worth stating, because each is a place the obvious
choice is wrong:

- **A `pr` step goes `running` with no session id.** That is the whole
  difference from a `gavin` action (§8.2), which resolves inside its own
  launch: waiting is a *state*, and a step that resolved immediately could
  not wait. It does not wedge the rail — the daemon's running-step guard
  exempts a row with no session, since there is no live agent to orphan.
- **On a rail that is not running, the wait stalls.** Only a running rail
  consults the poll, so a wait left `running` under a paused one is
  waiting on nothing that will ever look at it. It stalls with a reason
  saying exactly that, and Play relaunches it (rule 2).
- **An empty check rollup is not a pass, for the first two minutes.**
  GitHub returns `[]` both for a repo with no CI and for a PR whose
  workflow runs it has not registered yet, and `gh pr create` returns
  before it has. Reading the second as the first is how a rail advances
  past CI that never started.

`gh` failing is deliberately **not** a stall: a wait step's job is to be
patient, and a sleeping laptop or a dropped VPN must not cost a human a
Resume press. The reason rides the chips instead, where a genuinely
broken `gh auth` is visible. A `gh` that is not installed at all is the
exception, and that one stalls — waiting will not install it.

Merging is never gavin's. Nothing in this kind writes to GitHub.
