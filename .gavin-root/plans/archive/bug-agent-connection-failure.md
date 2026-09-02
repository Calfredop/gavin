---
kind: task
title: "[bug] a rail advances when its agent dies of a connection failure"
status: Done
priority: high
---
An agent session's status is two seconds of silence. `create_session` spawns
`/bin/sh -c "<agent> '<prompt>'"` (`crates/daemon/src/pty.rs:41`), a
non-interactive shell that emits no OSC 133, so `seen_osc133` never flips and
`spawn_heuristic_idle_timer` (`crates/daemon/src/server.rs:183`) is the only
thing that ever calls such a session `Idle`: `HEURISTIC_QUIET_PERIOD`, two
seconds, `crates/daemon/src/status.rs:262`. An agent that finished its turn and
an agent whose API connection died produce byte-identical signals.

One code path reads that silence as success. `agentTurnEnded`
(`app/src/lib/orchestration.ts:389`) takes `idle` on an `agent`-kind tool step
as "the turn ended. Done.", and rule 3b marks the step done
(`orchestration.ts:813`), which advances the rail to the next stage. The next
step then runs against a checkout where the previous step did nothing, and no
surface in the app says so. That is the headline defect: a rail that quietly
advances on work that never happened.

The interrupted-agent-runs work does not reach any of this. It keys on the
daemon epoch, and none of the failures below kill the daemon — every one of
them leaves `interruptedSessionIds` empty, so rule 3c never fires. Read that
card (`.gavin-root/plans/archive/bug-interrupted-agent-runs.md`) first anyway:
its rule-3c shape and its surface list are the pattern this card extends to a
different cause of death. Root 3 below deliberately revisits its "stall rather
than relaunch" judgement, which was reached on the assumption that the agent's
own transcript was out of reach.

## The family

The originating case is a laptop leaving the office: lid closed mid-rail,
everything suspends, and on wake every agent's TCP connection to the API is
dead while the processes are all still alive. But the shape is general —
**the agent stops producing output without finishing** — and it has at least
six causes worth measuring:

- suspend, then a network change (lid closed at the office, opened at home)
- a Wi-Fi drop or VPN flap while the machine is awake
- an API outage or a run of 529s
- usage-limit exhaustion mid-turn
- auth expiry — the agent wants `/login`
- the agent process crashing outright

Do not assume they behave alike. For each, record by observation: does the
process exit or survive? with what exit code? does it ring a BEL or emit an
OSC 9/99/777 first (which would land it in `waiting_for_input`, a different and
much better outcome)? and what does the error look like on screen? Fixing the
case you assumed is worse than not fixing it — a wrong failure detector paints
healthy sessions as broken and pauses rails for nothing.

Where each outcome lands today:

- **the process exits non-zero** — already correct. `deadSessionAction` stalls
  the step and rule 5 pauses the rail. Whatever this card changes, keep it.
- **the process survives and goes quiet** — the defect above for an agent tool
  step. For a *card* step it is a hang rather than corruption: `stepAttentions`
  marks it `turn-ended` (`orchestration.ts:542`) and the step sits `running`
  for good, so the rail waits on a session that will never speak again.
- **a `command` tool step** — the exit code is the whole verdict (tools spec
  T5), so this one is right either way.

## Root 1 — nothing in gavin knows what a failure is

`grep -rin "api error\|network\|offline\|rate limit"` over `app/src/lib` and
`crates/daemon/src` returns exactly one hit, an unrelated comment in
`git_status.rs`. There is no concept anywhere of an agent that stopped because
something broke, as distinct from one that stopped because it was done.

Two independent detectors. Build both — they catch different members of the
family, and neither alone is enough.

### 1a — the machine slept

A suspend is the one failure with a signal that owes nothing to the agent's
output, so it is the sturdier of the two and should carry the originating case.

Pair a monotonic reading with a wall-clock one on a daemon heartbeat and
compare their deltas against the interval. If Rust's `Instant` excludes
suspended time on macOS, the `SystemTime` delta runs ahead and the gap shows
there; if it includes it, the `Instant` delta itself jumps. Either way, time
passed that this process did not observe. **Measure which of the two it
actually is before writing the check** — a heartbeat that reads the wrong
clock detects nothing and passes its own tests.

Every session that was `Working` across the gap is then suspect: its network
conversation predates the gap and it has not spoken since. That is a fact the
daemon can state, unlike anything inferred from quietness.

Note the interaction with `HEURISTIC_QUIET_PERIOD`: whichever way the clock
behaves, the quiet timer will fire `Idle` within about two seconds of wake for
any session the sleep silenced. The suspect mark has to reach the app before or
with that transition, or the rail advances first and the mark arrives too late
to matter.

### 1b — the agent said so

The remaining five causes leave their evidence on screen and nowhere else.
`StatusScanner` (`crates/daemon/src/status.rs`) is the established seam for
"watch every PTY byte and derive a status", but it is an OSC scanner and an
error banner is plain text painted by a TUI, so a raw-byte substring match will
straddle cursor moves and redraws.

Match the *rendered* screen instead. The daemon already maintains a vt100
screen model per session and feeds it the same bytes
(`crates/daemon/src/server.rs:1473`) — that model is where "API Error" is
contiguous text rather than a stream interleaved with escape sequences.

The patterns belong to the **agent profile**, not to the daemon and not to
Claude Code. Opencode integration is a live card, its error text will differ,
and a hardcoded pattern is a silent regression the day a CLI reworks its
messages. Treat a profile with no patterns as "no failure detection", never as
"nothing failed".

## Root 2 — the status vocabulary has no room for failure

`SessionStatus` is `Idle | Working | WaitingForInput | Exited`
(`crates/daemon/src/registry.rs:5`) and the TS side is a three-string union
(`app/src/lib/notifications.ts:4`). A failed agent is not representable, so
every consumer would keep re-deriving it.

Two traps in adding to it:

- `SessionStatus::from_str` maps everything it does not recognise to `Idle`
  (`registry.rs:27`). For this feature that default is exactly backwards: a
  status meaning "this agent broke", persisted by a new daemon and read back by
  an older one, becomes the one value that marks rail steps done.
- `StatusChanged` carries the status as a plain string, so a new value is
  invisible to `min_version_for` — that gate covers request TYPES, not payload
  contents. There is no gate entry to add here; the protection has to be that
  an unrecognised status never reads as `idle` on either side. Fix the fallback
  in both languages.

## Root 3 — the recovery is a resumed conversation, not a fresh prompt

Detecting a failure and naming it only sets up the question of what the human's
one press actually does. Today gavin has a single answer:
`composeResumeTaskPrompt` (`app/src/lib/cardRun.ts:185`) and the gavin-resume
skill hand a *new* agent a written account of what the last one was doing. That
is a reconstruction, and it is what the interrupted card settled for because
there the process and its context were both gone.

Here the agent's own transcript is still on disk and the CLI can reopen it.
`claude --resume <session-id>` resumes a conversation by id, `-c/--continue`
resumes the most recent one in the cwd, and `--session-id <uuid>` lets the
CALLER fix the id at launch. That last flag is the whole design: gavin mints
the uuid when it builds the run command, so it always holds the conversation id
without scraping `~/.claude/projects` or guessing by mtime. `--continue` is not
an acceptable substitute — it keys on cwd, and this repo routinely has several
agent sessions live in one worktree, so it would cheerfully resume somebody
else's conversation.

- **Launch.** `buildRunCommand` (`cardRun.ts:97`) gains the id-fixing argv, and
  every caller that launches an agent records the uuid alongside gavin's own
  session id. Persisting it is the protocol change, and it belongs with the RUN
  rather than the tab: it has to outlive the session that produced it.
- **Resume.** The recovery action becomes `<command> <resume_args> <uuid>` in
  the same cwd, replacing the failed session in place.
- **The argv is per profile, and only where verified.** This is the shape
  `headless_args` already has in `AGENT_PROFILES`
  (`app/src-tauri/src/agent_setup.rs:185`), reasoning included: getting it wrong
  "puts garbage in the agent's argv, so agent-driven flows are hidden rather
  than risked". Add the resume and session-id argv as sibling fields under the
  same verified-rows-only posture. opencode's equivalents are unverified —
  that belongs in the opencode argv spike, alongside the conventions it is
  already pinning down, not guessed here.
- **A profile without a verified resume argv keeps today's behaviour** and
  falls back to `composeResumeTaskPrompt`. The two layer cleanly: conversation
  resume where the CLI supports it, written reconstruction where it does not.
  Do not delete the fallback.

Prior art worth reading before designing this: cmux
(`https://github.com/manaflow-ai/cmux`) ships exactly this feature across a
dozen agent CLIs, and three of its hard-won details contradict the obvious
implementation.

- **A third way to learn the id: the agent's own hooks.** Besides fixing the id
  at launch, cmux injects hook scripts into each agent's config and keeps a
  `<kind>-hook-sessions.json` store (`CLI/ClaudeHookSessionStoreFile.swift`,
  `CodexHookInjectionSchema.swift`). That route works even for an agent that
  will not accept a caller-supplied id, and gavin is already in the business of
  writing agent config — `agent_setup.rs` installs the MCP entry and the gavin
  skills. Weigh it against `--session-id`, which is simpler where it exists.
- **The cwd that resume needs is the LAUNCH cwd, not the current one.** Claude
  keys its session store by directory (`projects/<encode(cwd)>/`) and
  `--resume` only finds a conversation from that same directory. cmux's
  `restorableWorkingDirectory` (`Sources/RestorableAgentSession.swift:2851`)
  records that a hook-reported cwd "drifts when the agent `cd`s elsewhere
  mid-session (e.g. starting in a repo root, then moving into a worktree), so
  trusting it makes resume fail with 'No conversation found'". **Gavin walks
  straight into this**: `update_cwd` rewrites `record.cwd` from OSC 7 on every
  directory change, so the cwd gavin has stored is precisely the drifted one.
  The launch cwd has to be recorded separately and kept. cmux also models this
  per agent (`AgentCwdNamespacing`) because kinds that key by id and record the
  cwd inside the session file — Codex, OpenCode — want the opposite: the
  recorded cwd, so the agent reopens where it was.
- **Verify the binding before exec'ing a resume.** cmux does not trust a stored
  id: `CodexSessionResumeVerifier` checks the transcript actually exists, and
  `codexRestoreValidation` revalidates "at the last safe boundary before
  execve", returning `.bindingChanged` and refusing to run when the id it holds
  is no longer the session's — "never execute the stale record, and never clear
  the newer binding". A resume against a stale id is how you get the silent
  fresh conversation this card is trying to avoid.

Two decisions to settle by observation rather than assumption:

- **Reuse the id, or fork it?** `--resume` extends the original transcript;
  `--fork-session` branches into a new one. Forking keeps a failed attempt
  readable after the retry — which is precisely when you want to read it — and
  cmux's transcript tailer notes that a resume ROTATES or REWRITES the
  transcript it resumes, so reusing may not leave the failed attempt readable
  at all. Reusing keeps one conversation per step and is simpler to display.
  Pick one and record why.
- **What does a transcript ending in a broken turn do?** The connection died
  mid-request, so the last entry may be an errored or half-finished tool call.
  Resume one and watch, before designing around a guess; this is the one part
  of the flow with no prior art anywhere in the repo.

## Surfaces

Everything that reads a session status is currently willing to lie about a
failed one. Enumerate them and make them agree:

- **rail step completion** — `agentTurnEnded` must not complete a step on a
  failed session. Stall it with a reason of its own, the way rule 3c does for
  an interrupted one. Not a relaunch and not a retry: the human decides, and
  Resume already retries a stalled step (rule 2).
- **`stepAttentions`** (`orchestration.ts:488`) — `turn-ended` is the wrong
  word for this. It means "the agent stopped talking", which is true and
  useless; the human needs to know it broke.
- **notifications** — `notifications.ts:96` fires "`<label>` finished" on
  working → idle. Today a network-killed agent sends the human an OS
  notification telling them it finished.
- **the tab dot** (`Pane.svelte`), **the sidebar badge**
  (`sidebarSummary.ts`), **the board card** (`BoardCard.svelte`) — the same
  three surfaces the step-attention work already touched.
- **standalone card runs** — a card bound to a failed session must stop
  reading as a live run and offer Resume instead of a jump. Surface 2 of the
  interrupted card built exactly this; route into it rather than rebuilding it.
- **hidden commit runs** — `adoptAgentCommits` / `watchAgentCommit`
  (`gitState.ts`) wait on a headless run that does exit, so this is probably
  already fine. Confirm it; do not assume it.

## Deliberately out of scope

- **Process reattachment.** A PTY child that is gone is gone; nothing here
  adopts a live process it did not spawn. That is what the interrupted card
  actually ruled out, and Root 3 is not it — resuming a conversation is a fresh
  process reading a transcript off disk.
- **Unattended auto-resume.** Resume is one press, not a loop. An automatic
  retry into a network that is still down burns a rail's steps for nothing, and
  a rail that resumes itself six hours after the human walked away has made a
  decision that was theirs to make. Carried by its own card,
  `.gavin-root/plans/feat-auto-resume.md`, which is downstream of this one
  and depends on it landing a failure REASON, not a bare failed flag.
- **Keeping the machine awake.** A `caffeinate`-style hold for the duration of
  a running rail is a reasonable feature and a different card. This one is
  about telling the truth afterwards.

## Constraints

- Never `pkill gavin-daemon` — it is shared and long-lived. Run an isolated
  daemon under a temp `$HOME` for every experiment here; it gets its own socket
  and databases.
- A protocol change needs a `PROTOCOL_VERSION` bump (currently 20) and its
  `min_version_for` entry, subject to the Root 2 caveat about what that gate
  can and cannot see.
- A new field on `AGENT_PROFILES` follows that table's established posture:
  verified rows only, and a profile without one hides the flow rather than
  guessing an argv.
- Logic goes in the pure `.ts` modules with unit tests; the `.svelte` files
  stay thin templates over them.

## Checks

`cargo test --workspace`, then `cd app && npm test && npm run check && npm run
build`. The daemon's `gavin::tests` are flaky under full-suite cargo
parallelism — re-run that module alone before calling a failure a regression.

The suites cannot reach the part that matters. The family table above has to be
filled in by observation, under a temp `$HOME`: launch an agent session, break
its connection — pull the network, or point the agent at an unreachable API
base URL, which is the reproducible version — and record the status
transitions, whether the process exits, and what the screen model holds. Do the
same across a real machine suspend for 1a.

Root 3 needs its own end-to-end pass before any UI is wired to it: launch an
agent with a fixed session id, break the connection mid-turn, resume by that id,
and confirm it comes back carrying its context rather than starting over. A
resume that silently begins again is the from-scratch second attempt this whole
family of cards exists to prevent, wearing a better name.

Report what was observed, including any case that turned out not to behave as
this card predicts.
