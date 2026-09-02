# Agent failure detection and conversation resume

An agent session's `idle` is two seconds of silence. `create_session` spawns
`/bin/sh -c "<agent> '<prompt>'"`, a non-interactive shell that emits no
OSC 133, so `spawn_heuristic_idle_timer` is the only thing that ever calls such
a session `Idle` — `HEURISTIC_QUIET_PERIOD`, two seconds. An agent that finished
its turn and an agent whose API connection died produced byte-identical signals,
and `agentTurnEnded` read that silence as success: the rail marked the step done
and advanced to the next stage against a checkout where the previous step did
nothing.

Everything below the first heading was measured, not assumed. The measurements
are the load-bearing part of this document: a wrong failure detector paints
healthy sessions as broken and pauses rails for nothing.

## The family, as measured

Claude Code v2.1.258, driven in a real PTY against a fake API on localhost
(`ANTHROPIC_BASE_URL`), one prompt per run, watched until the screen went quiet
for twenty seconds. "Rendered screen" is the vt100 model's `contents()`, which
is what the daemon matches against.

| Cause | Process | BEL / OSC 9,99,777 | Rendered screen when it stops |
| --- | --- | --- | --- |
| connection reset before any response | **alive**, quiet after ~3m of retries | none | `API Error: Connection dropped (ECONNRESET)` |
| connection killed mid-stream | **alive**, quiet in ~11s | none | `API Error: API returned an empty or malformed response (HTTP 200) …` |
| 529 overloaded | **alive**, quiet after ~3m of retries | none | `API Error: 529 Overloaded. This is a server-side issue…` |
| 429 usage limit | **alive**, quiet after ~3m of retries | none | `API Error: Server is temporarily limiting requests … You have exceeded your usage limit.` |
| 401 expired token | **alive**, quiet after ~3m of retries | none | `Please run /login · API Error: 401 OAuth token has expired. Please run /login` |
| server accepts and never answers | **alive**, never quiet | none | `API error · Retrying in 0s · attempt 1/10`, repainting forever |
| headless (`-p`) run, same failures | **exits 1**, prints the same `API Error:` line | none | n/a |

Four things follow, and three of them contradict something one might have
assumed:

- **No case rings a bell or emits an OSC 9/99/777.** None of them lands in
  `waiting_for_input`, which would have been the much better outcome. The
  daemon's OSC scanner cannot see any of this.
- **The process survives every interactive failure.** The exit-code path
  (`deadSessionAction`, rule 5) never fires, and the session stays in
  `liveSessionIds`. This is why rule 3d had to be a new rule rather than a
  widening of rule 3.
- **`API Error:` is the one string every terminal case shares**, and the
  *retrying* banner deliberately does not match it: it reads `API error ·`,
  lower-case and unpunctuated. So even a detector that ran continuously would
  not condemn a session that is still retrying. The daemon consults the verdict
  only at the transition a quiet session would otherwise make to `Idle`, which
  is a second, independent reason the same false alarm cannot happen.
- **The hung-server case never goes quiet at all**, so it never reads as `idle`
  and the rail simply waits. Not a false verdict, and not fixed here — a rail
  that waits forever on a spinner is the time-limit card's problem, not this
  one's.

The last row is the reason nothing was armed for hidden commit runs: a headless
run exits non-zero on exactly these failures, so `watchAgentCommit` already
reaches a truthful verdict through the exit code. Confirmed rather than assumed.

## The clocks (root 1a)

The suspend detector compares a monotonic reading with a wall-clock one. Which
of the two runs ahead across a sleep is a fact about the platform, and reading
the wrong one detects nothing while passing its own tests. Measured on this
machine (17.2h of accumulated sleep since boot):

```
Instant::now()        => Instant { tv_sec: 371638 }   # == CLOCK_UPTIME_RAW
CLOCK_UPTIME_RAW      371638s   since boot
CLOCK_MONOTONIC_RAW   433667s
CLOCK_MONOTONIC       433662s
wall clock            433650s   since kern.boottime
```

Rust's `Instant` on macOS **is** `CLOCK_UPTIME_RAW`: it excludes suspended time.
So the `SystemTime` delta is the one that runs ahead, and `wall - mono` is the
gap. A watchdog reading only `Instant` would see nothing.

The same measurement settles the ordering, and this is where the design was
wrong on the first pass. `HeuristicInner::last_activity` is an `Instant` too, so
a suspend is invisible to the quiet timer — which is good news for every session
that was already quiet (no burst of spurious `Idle` on wake) and bad news for
the one that was mid-turn: its timer starts counting from the wake and fires
`Idle` two seconds later. The mark is read at exactly that transition, so it has
to be published first. `SUSPEND_POLL_INTERVAL` is therefore one second, not the
ten a gap measured in hours would otherwise deserve, and
`the_suspend_watchdog_must_outrun_the_quiet_timer` asserts the relationship
rather than trusting the comment.

## Conversation resume (root 3)

Verified end to end, in a scratch directory, with the real CLI:

- `claude --session-id <uuid> …` accepts a caller-minted id and writes the
  transcript to `~/.claude/projects/<encoded cwd>/<uuid>.jsonl`. Gavin therefore
  holds the conversation id from the first byte and never scrapes the store or
  guesses by mtime.
- `claude --resume <uuid> …` came back carrying the conversation (asked for a
  codename set in the first turn, answered correctly).
- **Resume APPENDS to the same transcript file** — 42,449 → 45,717 → 48,935
  bytes, same name, no rotation. cmux's transcript tailer warns that a resume
  may rotate or rewrite what it resumes; that does not reproduce here. Since the
  failed attempt stays readable either way, the one argument for `--fork-session`
  does not apply, and gavin reuses the id: one conversation per step, simpler to
  display.
- **`--resume <uuid>` from a DIFFERENT directory still worked**, appending to the
  original project's transcript. cmux's `restorableWorkingDirectory` reports
  "No conversation found" for this case; it does not reproduce on this version.
  The launch cwd is recorded and used anyway, for the other reason: the resumed
  agent has to *run* where the work is, and `record.cwd` is rewritten from OSC 7
  on every `cd`, so it is precisely the drifted value.
- **Reusing a `--session-id` that already exists is a hard failure**:
  `Error: Session ID <uuid> is already in use.`, and nothing starts. This is not
  a nuance — it means `relaunchCard`, which replays the stored command verbatim,
  would have been broken outright by the launch change. It now mints a fresh id
  into the stored command (`withFreshConversationId`), which is also what the
  button means: re-launch starts over, Resume reopens.

The one question with no prior art anywhere — what a transcript ending in a
broken turn does on resume — is **not answered here**. The resume passes above
were against cleanly-completed turns. See "Left open" below.

## Shape of the change

- **Daemon.** `SessionStatus` gains `Failed` and `Unknown`; `from_str` no longer
  maps the unrecognised to `Idle`, which for this feature was exactly backwards
  (`idle` is the one value that marks rail steps done). `Request::SetFailurePatterns`
  hands the daemon the agent profile's own error text per session; the verdict is
  taken from the **rendered screen**, not the byte stream, because an error banner
  is plain text painted by a TUI and a raw substring match would straddle cursor
  moves. `Response::SessionFailed` carries the reason, `SessionSummary.failure_reason`
  re-baselines it on Attach. `PROTOCOL_VERSION` 21.
- **Profiles.** `failure_patterns`, `session_id_args` and `resume_args` join
  `headless_args` on `AGENT_PROFILES`, under the same verified-rows-only posture:
  only claude-code carries any. A profile with no patterns gets NO failure
  detection — never "nothing failed" — and one with no resume argv keeps the
  written reconstruction (`composeResumeTaskPrompt`). opencode's equivalents
  belong in the opencode argv spike.
- **Orchestration.** Rule 3d, checked before 3c and 3b, stalls a running step
  whose session failed, with the agent's own line as the reason. A stall and not
  a relaunch: rule 5 pauses the rail and the human decides. `stepAttentions`
  gains `failed`, ranked above `asking`.
- **Surfaces.** The tab dot, the sidebar recap's own bucket, the board card, the
  card detail modal's Resume, the card menu, and the OS notification — which used
  to tell the human a network-killed agent had *finished*.

## Two daemon bugs the tests found on the way

Both were in the first pass at this feature and neither is about failure
detection as such; they are recorded because the second one is subtle enough to
be reintroduced.

- **A lock-order inversion between the idle timer and the pump.** The verdict
  reads the session's rendered screen, and the pump holds the screen's lock
  across feed-then-forward and takes `heuristic.inner` inside it. Computing the
  verdict while holding `inner` inverts that order, and the two threads
  deadlock — not intermittently degrade: the timer stops firing for that session
  altogether, and with it every status this feature depends on. The timer now
  drops `inner`, takes the verdict, re-takes `inner` and re-validates
  (`last_activity` unchanged) before emitting.
- **The acknowledgement was taken after the write.** "Whatever failure is on
  screen when the human types, they have read" is only true if the screen is
  read BEFORE the bytes reach the PTY. Taken after, the shell echoes and runs
  within milliseconds, so a failure produced by that very input was
  acknowledged before it had ever been seen — and the turn it belonged to read
  as a clean finish. This is exactly the defect the feature exists to fix,
  reached through a side door.

The test helpers had a matching hazard worth keeping: each wait built a fresh
`BufReader` over a clone of the socket, discarding whatever the previous one had
buffered, so a test that waited twice blocked for ever on a status that had
already arrived. One reader now runs the length of a test, and a watchdog thread
shuts the read half down so a missing status FAILS the test rather than hanging
the suite.

## Left open

- **A transcript that ends in a broken turn.** Resume was verified against
  completed turns only. If a half-written tool call trips the CLI on resume, the
  failure is visible (the tab is a real session showing the CLI's own error) but
  gavin does nothing clever about it.
- **Binding verification before exec.** cmux revalidates the id "at the last safe
  boundary before execve" and refuses a stale one. Gavin writes the id and the
  run together on every launch, so a stale id cannot outlive its run — but there
  is no check that the transcript still exists.
- **Hook-captured session ids** (cmux's `ClaudeHookSessionStoreFile`), the route
  for an agent that will not accept a caller-supplied id. Not needed while
  claude-code is the only verified row.
- **Unattended auto-resume** — `.gavin-root/plans/feat-auto-resume.md`, which is
  downstream of this and depends on the failure REASON landing.
