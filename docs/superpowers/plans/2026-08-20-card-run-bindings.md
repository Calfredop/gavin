# Card Run & Bindings Implementation Plan (3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cards become executable — Run on tasks/plans spawns a visible agent with a generated prompt, writes In Progress, and binds the session to the card (dot, jump, re-launch, unlink) via a runtime `card_sessions` table.

**Architecture:** Daemon-side `card_sessions` rides the Board reply; prompt/command composition is a pure TS module; the run flow reuses `handleAgentSessionSpawned` (Agents-page landing, D19). Protocol bumps to 5. `SKILL.md` learns the full card vocabulary.

**Tech Stack:** Rust daemon, Svelte 5, TypeScript, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-kanban-card-model-design.md` §3 (run + bindings), §6 plan 3. Prerequisites: plans 1–2 landed.

## Global Constraints

Same as plans 1–2 (zero deps; files are truth; patch-on-success; svelte-check 0 errors / 0 kanban warnings; main; commit per task with the trailer; no push). The app **never auto-completes** a card.

---

### Task 1: Protocol v5 + daemon card_sessions

**Files:**
- Modify: `crates/protocol/src/lib.rs`, `crates/daemon/src/kanban.rs`, `crates/daemon/src/server.rs`

**Interfaces (produces):**

```rust
#[serde(rename_all = "camelCase")]
pub struct CardSession { pub path: String, pub session_id: String, pub cwd: String, pub command: Option<String> }
// BoardLoaded/Board reply gains: pub card_sessions: Vec<CardSession>
Request::LinkCardSession { workspace_id, path, session_id, cwd, command }   // upsert by (workspace_id, path)
Request::UnlinkCardSession { workspace_id, path }
```

```sql
CREATE TABLE IF NOT EXISTS card_sessions (
  workspace_id TEXT NOT NULL, path TEXT NOT NULL, session_id TEXT NOT NULL,
  cwd TEXT NOT NULL, command TEXT, PRIMARY KEY (workspace_id, path)
)
```

`PROTOCOL_VERSION` 4 → 5.

- [ ] **Step 1: Failing tests:** table CRUD (upsert replaces, unlink removes, absent unlink is a no-op), Board hydration includes the workspace's bindings, camelCase shape test, roundtrips, version guard update. **Step 2:** implement (kanban.rs storage + server.rs handlers + Ok replies) → `cargo test` green. **Step 3:** Commit — `feat(daemon): card_sessions runtime bindings on the board (v5)` + the trailer.

---

### Task 2: Frontend bindings state

**Files:**
- Modify: `app/src/lib/kanban.ts` (`Board` gains `cardSessions: CardSession[]`, new `CardSession` interface), `app/src/lib/backend.ts` (`linkCardSession`, `unlinkCardSession` invokes + Tauri commands in `app/src-tauri`), `app/src/lib/kanbanState.ts` (+ tests)

**Interfaces (produces):**

```typescript
export interface CardSession { path: string; sessionId: string; cwd: string; command: string | null }
// kanbanState:
export function cardSessionFor(board: Board | undefined, path: string): CardSession | null
export async function linkCardSessionAction(workspaceId, binding: CardSession): Promise<void>
export async function unlinkCardSessionAction(workspaceId, path: string): Promise<void>
// Both: optimistic board update (cardSessions replaced/filtered), backend call,
// rollback + saveErrors entry on failure -- the mutateAndPersist pattern, but
// via the two targeted requests instead of setBoard.
```

- [ ] **Step 1: Failing tests:** optimistic upsert/remove, rollback on rejection (reference-equality guarded like mutateAndPersist), `cardSessionFor` lookup, board fetch carrying bindings through `fetchBoard`. **Step 2:** implement (incl. the two Tauri commands forwarding to the daemon) → vitest + cargo green, svelte-check 0. **Step 3:** Commit — `feat(app): card session binding state` + the trailer.

---

### Task 3: cardRun.ts — pure prompt/command composition

**Files:**
- Create: `app/src/lib/cardRun.ts` (+ test)

**Interfaces (produces):**

```typescript
export function composeTaskPrompt(path: string, title: string, body: string): string
// "You are executing the task card at <path> ("<title>").\n\n<body>\n\n
//  While you work, keep this card's status current with
//  gavin_set_plan_field on <path>; set it to the board's done column when finished."
export function composePlanPrompt(path: string): string
// "Read <path> and execute that plan. Work its checklist top to bottom:
//  tick items (- [x]) as you complete them, promote items that need their
//  own agent with gavin_promote_task, and keep the plan's status current
//  with gavin_set_plan_field."
export function shellQuote(s: string): string          // single-quote wrap, '\'' escaping
export function buildRunCommand(agentCommand: string, prompt: string): string
// `${agentCommand} ${shellQuote(prompt)}`
export function runStatusNeeded(currentStatus: string | null): boolean
// slugStatus(currentStatus ?? "") !== slugStatus("In Progress")
```

- [ ] **Step 1: Failing tests:** exact template strings (snapshot the two prompts), shellQuote round-trips quotes/newlines/backslashes (`echo` the composed command through `sh -c` in a comment, assert the string form), runStatusNeeded truth table ("In Progress", "in-progress", null, "Done"). **Step 2:** implement → PASS. **Step 3:** Commit — `feat(app): run prompt/command composition` + the trailer.

---

### Task 4: The run flow

**Files:**
- Create: `app/src/lib/cardRunActions.ts` (+ test with mocked backend/layout helpers)

**Interfaces (produces):**

```typescript
// Returns an error string or null. One live session per card: an existing
// binding whose session is still present in the workspace jumps to it
// (switchWorkspaceView + switchToSessionInPage) and spawns nothing.
export async function runCard(workspaceId: string, card: CardView): Promise<string | null>
```

Flow (order matters, each step awaited): existing-binding jump check → prompt (task: `readFileForViewer(card.id)` + `stripFrontmatter` for the body; plan: pointer prompt) → `backend.createSession(card.contextFolder, buildRunCommand(agentCommand, prompt))` (agentCommand from the workspace, default "claude") → `handleAgentSessionSpawned(workspaceId, sessionId)` (Agents-page landing, attached, no focus steal) → `linkCardSessionAction` → if `runStatusNeeded(card.status)`: `setPlanFrontmatterField(card.id, "status", "In Progress")` + patch. A nested task being run gets a status and therefore frees itself from its plan — deliberate: it is actively in progress. Re-launch: `relaunchCard(workspaceId, path)` recreates from the stored binding (cwd/command) and re-links — port of the old modal behavior.

- [ ] **Step 1: Failing tests:** jump-instead-of-spawn when bound+alive; full spawn call order (create → land → link → status); status write skipped when already slug-matching; plan cards never read the body; error propagation (createSession failure → error string, nothing linked). **Step 2:** implement → PASS. **Step 3:** Commit — `feat(app): runCard flow with Agents-page landing` + the trailer.

---

### Task 5: Surfaces — dots, run buttons, session block, Run now

**Files:**
- Modify: `app/src/lib/BoardCard.svelte`, `app/src/lib/CardDetailModal.svelte`, `app/src/lib/KanbanColumn.svelte` (composer), `app/src/lib/KanbanBoard.svelte`/`BoardPane.svelte` (prop threading for cardSessions if needed)

- [ ] **Step 1:** BoardCard: session status dot (binding via `cardSessionFor` + `sessionStatusById`, the four states incl. exited-ring) for task/plan cards; a hover ▶ Run affordance (task/plan, hidden while a binding is live — the dot + click-through cover it) calling `runCard`; errors → the board's error strip.
- [ ] **Step 2:** Modal session block (tasks and plans): live binding → status + cwd + Jump / Re-launch (disabled while alive) / Unlink; none → Run. Prompt preview for tasks (the body, labeled "Prompt").
- [ ] **Step 3:** Composer: task kind gains a "Run now" checkbox — on create success, `runCard` the fresh card (composed CardView from the create args).
- [ ] **Step 4:** svelte-check 0 / vitest green; manual: run a task → agent lands on Agents page attached, card shows working dot + In Progress; run a plan → pointer prompt visible in the terminal; second Run jumps; re-launch after exit; unlink clears the dot.
- [ ] **Step 5:** Commit — `feat(app): run affordances, session dots, session block` + the trailer.

---

### Task 6: SKILL.md + MCP polish

**Files:**
- Modify: `app/src-tauri/src/gavin_skill.md` (the file `agent_setup.rs` writes), `crates/gavin-mcp/src/main.rs` (only if any description is stale)

- [ ] **Step 1:** Rewrite the skill's board section: the card vocabulary (note/task/plan + kind frontmatter), the nesting rule (child without status is nested; status frees it), plan checklists + `gavin_promote_task` + tick-when-done convention, labels, and the run contract (a human may run your card — keep `status` truthful; set the done column when finished). Keep the existing structure (read PRD first, plan before coding, spawn visibility).
- [ ] **Step 2:** `cargo test` green (agent_setup tests assert file writing, not content — verify); re-run "Set up agent integration" manually in the dev workspace and confirm the new skill lands. **Step 3:** Commit — `docs(skill): card kinds, nesting, promotion, run contract` + the trailer.

---

### Task 7: Checklist, docs, final sweep

- [ ] **Step 1:** Smoke section "Run & bindings" (`run-task`, `run-plan`, `run-jump-not-double`, `run-inprogress`, `run-relaunch`, `run-unlink`, `run-now-composer`, `skill-updated`); fixture README walkthrough for one full loop: compose task → Run now → agent works → ticks/status → done.
- [ ] **Step 2:** Full gates (`cargo test`, vitest, svelte-check 0/0, `npm run build`) + the manual pass; append execution notes + any incidents to the brainstorm log; set plan 3's gavin card Done and close out the card-model effort.
- [ ] **Step 3:** Commit — `docs: run & bindings checklist + execution log` + the trailer.
