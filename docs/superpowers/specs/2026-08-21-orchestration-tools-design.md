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
| T11 | **Added 2026-09-04:** a tool carries its own **working directory** (`cwd`, relative to the workspace root, absolute kept as written, absent = the root). It is read **only by a standalone run** (T12). A rail step still runs in the rail's checkout and ignores it — T6 is unchanged, and deliberately so: rail conflict detection is computed off `worktreePath ?? rootPath`, so a step that quietly jumped out of its worktree would let two rails collide with nothing left to warn about. See §10. |
| T12 | **Added 2026-09-04:** a tool can be run **standalone** from a per-workspace **Tools** hub tab — the same library, filtered to the three kinds that mean anything without a rail (`agent`, `command`, `script`), with **one session per run** and a run the **daemon** remembers. Sequencing stays orchestration's job: a multi-step deploy is written as one `script` tool, because bash already sequences. See §10. |
| T14 | **Added 2026-09-07:** a tool carries its own **icon** — a NAME from the app's curated library (`ui/iconLibrary.ts`), never an image — drawn wherever tools are listed, in place of the glyph its KIND imposes. Absent means "wear the kind's", which is what every tool authored before v33 means. A name this build cannot resolve falls back to the kind and is **kept** on the next save. See §12. |
| T13 | **Added 2026-09-04:** a human can author **every** kind, and the Tools tab **edits** as well as runs. What kept `gavin`, `until` and `pr` built-in-only was never the scheduler — every rule about them branches on the KIND — it was an edit form with one body field. The form now has three (source / an action select / none), so all six are authorable and every built-in offers Duplicate. The Tools tab lists the whole library, with Run dark and a reason on the three that only mean something as a step. See §11. |

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
  /// Where a STANDALONE run happens (T11, v30). A rail step ignores it.
  cwd?: string | null;
  /// The glyph this tool draws everywhere it is listed (T14, v33): a
  /// name from `ui/iconLibrary.ts`. Absent = wear the kind's.
  icon?: string | null;
}
```

`scope` is **derived, not stored**: the daemon stores `workspace_id`
(`NULL` = global) and the app labels the row. Built-ins never reach the
daemon at all.

`gavin` was added by §8. `TOOL_KINDS` — what the library dialog's chips
offer — stays the three **authorable** kinds; the fourth is built-in only.

`cwd` was added by §10. It is `Option<String>` on the wire, which widens
an **existing** request (`SaveTool`) and is therefore invisible to
`min_version_for`: a v29 daemon takes the save, drops the directory and
hands the tool back rooted wherever the launcher stood. The gate that
matters is the app's `FEATURE_MIN_VERSION.toolCwd`, and its consumer is
the library dialog's field, which is disabled with the reason rather than
accepting a value the daemon throws away.

`icon` was added by §12, at v33, and it is the same widening of the same
request with the same blind spot — `FEATURE_MIN_VERSION.toolIcon` is its
only gate, and the picker is the one surface that can produce the
payload. One difference is worth naming: an icon is **purely cosmetic**,
so a dropped one has no second symptom to notice later. A dropped working
directory eventually runs something in the wrong place; a dropped icon
simply never appears.

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

*Edit mode*: name, description, kind (radio chips), scope (This
workspace / All workspaces), body (a textarea; monospace for `command` and
`script`), and a params editor — rows of name/label/default with add and
remove. Beneath the body, a live list of the `{{placeholders}}` found in it,
flagging any that no param declares.

**Amended 2026-09-04 (T13):** the chips offer all six kinds and the body
field takes its shape from the kind — see §11.

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

**Amended 2026-09-04 (T13):** no longer built-in-only. The library dialog
draws a `gavin` body as a **select** over `GAVIN_ACTIONS` rather than a
text box, which is what made the chip safe to offer — see §11.

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

**Amended 2026-09-04 (T13):** neither is built-in-only any more, and the
sentence above is why it was always safe — "a duplicate of either loops
because of what it IS". What was missing was a form that could write one:
§11.

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


---

## 10. Running a tool without a rail (added 2026-09-04)

Everything above assumes a rail. The library it describes was reachable
only as a step on one, so "commit the dirty tree" meant building a rail
and binding it to a checkout — three screens for one press. The **Tools**
hub tab is the launcher that was missing.

It is a launcher and nothing more. There is **one** library
(`orchestrationTools.ts` + `toolsState.ts`), **one** editor
(`ToolLibraryDialog`) and **one** built-in set behind both tabs, so a tool
written for a rail is runnable from here the moment it is saved, and the
reverse. What is new is only the rules about running one alone, which live
in `workspaceTools.ts`.

### 10.1 Which tools it offers

`agent`, `command` and `script` **run**; the other three do not.

Those three are unrunnable for one reason each, and all three reduce to
"this is a rule about a rail, not a piece of work": an `until` tool's
verdict sends the rail **backwards** (§9.1) and there is no rail to send;
a `pr` tool runs nothing at all and is pure waiting on a rail's branch
(§9.2); a `gavin` tool's body *names a rail action* (§8.1).

**Amended 2026-09-04 (T13):** they were *filtered out of the list*; they
are now **listed with Run dark**, each carrying its own sentence. The tab
edits tools as well as running them, and a filter by kind means the human
who switches a tool to Loop-until watches it vanish from the list they
are standing in — with no way back to it except a dialog they did not
open. `isRunnableStandalone` is unchanged and still gates every launch.

Rail-shaped built-ins are offered anyway — Merge assumes a rail's branch
and Push assumes a rail's checkout — because a human standing in the root
checkout may well mean exactly that. The filter is by KIND, which is a
structural fact, never by whether a body reads like a rail's.

### 10.2 One tool, one session

A run is one session, launched by exactly the functions a rail step uses:
`buildRunCommand` for an `agent` tool, `buildToolCommand` for a shell one.
Two builders would be two ways for one tool to behave.

It is **revealed**, named after the tool, bound to **no card**, writes
**no status**, and advances nothing. A shell tool's PTY can close in under
a second, so revealing it is also the only chance to read what it printed.

Sequencing stays orchestration's job. A multi-step deploy is written as
one `script` tool — bash already sequences, and a second sequencer inside
the Tools tab would be a rail with none of a rail's state.

### 10.3 The run is the daemon's record

`tool_runs` in `orchestration.sqlite`, shaped like `card_runs`: one row
per session a tool was ever run in, opened by `StartToolRun` and closed
either by the daemon or by the app. `Request::ToolRuns` answers with the
**last run per tool** rather than a history — the tab draws one chip per
row and would throw the rest away, and a response that grew with every run
would be paid for on every tab visit.

Kept by the daemon rather than in the app, because the whole value of the
record is the case where **nobody was watching**: a run that failed while
the human was in another workspace, or after the window closed, is still
on the row when they come back.

Four outcomes: `running`, `passed`, `failed`, `abandoned`. `passed`/
`failed` where `CardRun` says `exited`, deliberately — a card run's
verdict is the board, so the daemon only reports that the session stopped;
a tool run's whole point IS the verdict, and "exited with code 1" is the
evidence for it rather than a substitute for saying it.

### 10.4 The verdict, split where the daemon's knowledge is

Both halves are the **rail's own rules** (T5, §3.1.1), so a tool means the
same thing wherever it runs:

- A `command` or `script` run **passes on exit 0** and fails on anything
  else. The daemon writes this itself, off the session exit it already
  watches (`finish_tool_runs_for_session`), so it is right even with
  nothing attached and even with the app closed.
- An `agent` run **passes when its session goes `idle`** — its turn ended
  — and **fails when failure detection fires**. An interactive agent sits
  at its prompt forever, so nothing the daemon watches would ever close
  that row; the app files it (`SetToolRunOutcome`). The store's
  `outcome = 'running'` guard is what stops a later exit rewriting it.
- A run whose end nobody saw is `abandoned`, swept on daemon start-up and
  again when a read finds a `running` row whose session the registry no
  longer has. `ended_at` stays NULL: nobody watched it end, and the time
  somebody **looked** is a different fact.

**No auto-resume**, and that is the one rail rule not carried over: an
auto-resume exists to keep a rail moving, and there is no rail. A failed
tool run is a failed row and a Run button.

### 10.5 The working directory (T11)

Set in the library dialog, with a folder picker — `dialog:allow-open` is
the only OS dialog still permitted. Stored **relative to the workspace
root** when the picked folder is under it, because that is what makes a
tool portable: a global tool with an absolute path would run in one
repository from every workspace that could see it.

`resolveToolCwd` is the whole rule: absolute is kept as written, relative
joins the root, absent IS the root. It is called by the standalone launch
and by nothing else — `launchToolStep` does not consult it, and a test
pins that (`ignores the tool's own working directory and uses the rail's
checkout`).

### 10.6 Two more built-ins

`builtin:consolidate-repo` and `builtin:reconcile-repo`, both `agent`
tools, both written for a **workspace** rather than a rail: neither
assumes a branch of its own.

Consolidate is deliberately narrower than `builtin:commit`, which groups
what it finds and stops there. This one is written for the tree several
agents have been editing at once — the grouping rule is per-FEATURE and
the staging rule is explicit, because `git add -A` in a shared checkout
commits somebody else's half-finished work under this run's message.

Reconcile is a **report**, and its prompt says so three times. The obvious
next step from every one of its findings is a delete, and a branch that
looks abandoned to a reader of `git log` is regularly one somebody is
working in another checkout. What to remove is the human's call; what
exists is the question this answers.

Deploy is **not** shipped. A pipeline is per-project, and a built-in that
guessed at one would be a template every workspace had to delete.

---

## 11. Authoring every kind, and editing from the tab (added 2026-09-04, T13)

Two changes, and the second is why the first is safe.

### 11.1 The obstacle was the form, not the scheduler

`gavin` (§8), `until` and `pr` (§9) shipped built-in-only, and each
carried its own reason for it. They were all the same reason: **the edit
form had one body field**. A `gavin` body typed into a textarea could
name an action gavin does not have — a tool that stalls every step it is
dropped onto, discoverable only at launch. A `pr` tool has no body to
type at all, so a duplicate came back as a command whose text was the
word `await-pr`. An `until` duplicate came back as a plain `command`,
because the kind is a completion rule and the chips offered three.

None of that was ever a rule about *running* one. Every rule about these
kinds branches on `kind` — `isUntilStep`, `isPrStep`, the `gavin` branch
in `executeGavinAction` — and never on a built-in id, which T7 spent a
section establishing. A copy has always behaved exactly like its
original. What could not be expressed was the body.

### 11.2 Three body shapes (`toolBodyEditor`)

So the form grew the shapes the six kinds actually have:

| shape | kinds | what the form draws |
|---|---|---|
| `text` | `agent`, `command`, `script`, `until` | a textarea, labelled and sized per kind — `until`'s says **Check command**, because a step whose field says "Command" reads as one that runs once |
| `action` | `gavin` | a **select** over `GAVIN_ACTIONS`. The form cannot express an action gavin does not have, which leaves `validateTool`'s refusal guarding only a tool a *newer* gavin wrote |
| `none` | `pr` | no field, and a sentence saying gavin reads the pull request itself. What the step waits for is a parameter |

Two of the six impose their body, so switching kinds **stashes** the
authored one and puts it back on the way out. The stash is `string |
null`, not `string`: a new tool's body is blank, and blank is worth
restoring — conflating the two leaves `await-pr` sitting in a brand-new
tool's Command field.

The three whose params are **arguments** rather than text substituted
into a body (`until`'s `max`, `pr`'s `require`/`max`, `start-rail`'s
`rail`) name them under the parameter grid. `summaryParam` ignores a
param the tool does not declare, so a budget typed into `retries` reads
as *no budget* rather than as an error — the form is the only place that
mistake can be caught.

The **working directory** (T11) is hidden on those three. A rail step
runs in the rail's own checkout and never reads it (T6/T11), so on a kind
that only runs as a step it is a control with no effect — and one that
quietly kept a value would be read as having one. A value set before a
switch survives, hidden, and comes back with the kind.

### 11.3 Editing from the Tools tab

Every row carries **Edit** (a built-in carries **Duplicate to edit**),
and the bar carries **New tool** beside Manage tools…. All of them open
`ToolLibraryDialog` — the same dialog, seeded through a new `initialEdit`
prop — because the point is not having to find the row again inside a
dialog. One library, one editor, one store; a second form here would
drift from the first the moment either grew a field.

The draft comes from `editDraftFor`, which copies (the list re-renders
from the store the moment a save lands) and turns a **built-in into a
duplicate**: a built-in cannot be saved, so a form opened on one would
refuse after the human had typed.

`initialEdit` is read at **construction**, not in an effect. An effect
that re-ran for any reason would overwrite what the human had typed with
the draft they started from.

---

## 12. A tool's own icon (added 2026-09-07, T14)

Six `command` tools on one rail are six identical terminals. The kind
lookup (`toolKindIcon`) is a good answer to *what is this made of* and no
answer at all to *which one is this* — and at step-chip size the name is
truncated to a few characters, so the glyph is the only thing left that
could tell them apart and it is the one thing they all share.

So a tool may carry an icon of its own. `toolIcon(tool)` is what every
surface calls now: the author's pick, else the kind's glyph. The four
sites that draw a tool (drawer, library dialog, Tools tab, step chip) go
through it, for the reason they were collapsed onto one lookup in the
first place — a surface still calling `toolKindIcon` directly would draw
a terminal on the one tool its author deliberately made a rocket.

### 12.1 A name, from a curated library

The stored value is a **name**, never an image and never a component:
`ui/iconLibrary.ts` is 56 lucide icons in seven groups, and the name is
gavin's own key rather than lucide's — two entries (`history`,
`file-code-2`) are aliases whose underlying lucide name has already been
renamed once, and a tool must not lose its icon because an icon package
tidied up.

Curated rather than all of lucide, for two reasons. A picker over seven
thousand icons is a search box with no answer: the human does not know
what they are looking for, they are looking for something that will do.
And every name in the module is an **import**, loaded by all four
surfaces that draw a tool, so the list is a real cost.

The daemon validates **nothing** — it has nothing to validate against,
and a rule it invented would refuse a name a newer app knows. Skew is
handled at the only place that can: `iconByName` returns null for a name
this build has never heard of, `toolIcon` falls back to the kind, and
`toRecord` keeps the stored string verbatim. The drawing degrades; the
choice survives, and comes back on a build that can draw it.

### 12.2 Where the picker sits

On the **shared edit form**, so New tool and Edit tool both have it — a
tool can be given an icon while it is being written rather than only on a
second pass. Unlike the working directory (§11.2) **every kind** gets the
field: a rail step chip draws a tool's glyph whatever its kind, and it is
on a rail that the six identical terminals are.

The grid is behind a toggle, closed by default: it is seven groups of
glyphs in a form that already scrolls, and most edits are not about the
icon. Picking closes it, because the panel is tall enough to hide the
rest of the form and the choice is now on the button that opened it —
the search text survives, so reconsidering costs one click. Clearing is
its own control ("Use the kind's icon") rather than a second click on the
selected cell: no cell in a grid can mean *none*, and without an explicit
one the only route back from a wrong glyph would be deleting the tool.
