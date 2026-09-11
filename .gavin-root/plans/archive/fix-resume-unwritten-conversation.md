---
order: 8192
title: [fix] Resume offers a conversation the agent never wrote
status: Done
priority: medium
complexity: moderate
---
A card whose run died before the agent persisted anything is left offering a
Resume that can never succeed. Pressing it runs `claude --resume <uuid>`, the
agent answers that it cannot resume that session id, and the card sits there
offering the same doomed button forever. The human is shown the agent's raw
error and given no way forward.

Seen on `feat-windows-port-on-a-windows-machine.md`, whose binding reads:

```
claude --session-id ad468935-d260-44d4-8bf4-c160cd0fb162 'First, before anything else: …'
claude --resume     ad468935-d260-44d4-8bf4-c160cd0fb162   <- exited
claude --resume     ad468935-d260-44d4-8bf4-c160cd0fb162   <- exited
```

`~/.claude/session-env/ad468935-…` exists — an empty directory — so the CLI
really did start under that id. `ad468935-….jsonl` exists nowhere under
`~/.claude`. The conversation was never written, and Resume is asking for it
anyway.

## Why it happens

`buildResumeCommand` (`app/src/lib/cardRun.ts`) hands back a command whenever
the profile has `resume_args` and an id was recorded at launch. It returns null
in exactly one case: a profile that verified no resume argv. So the documented
fallback — `composeResumeTaskPrompt`, "a written reconstruction instead of the
conversation itself" — is keyed on **which agent this is**, never on **whether
the conversation exists**. A conversation id gavin minted is treated as proof
that a conversation happened, and minting it is the one thing gavin does before
the agent has done anything at all.

Could also be because of cards arriving from git repo and being bound to other machines. Investigate and file a card if that's the case.

**Investigated: not the case.** A card's binding (`card_sessions`: session id,
command, conversation id, launch cwd) lives in the daemon's own
`kanban.sqlite` under this machine's data directory, keyed by workspace id
and card path. Nothing session-related is in the card file's frontmatter, so
a checkout arriving from git carries no binding at all. The dead conversation
on the Windows-port card was minted on this machine and died on this machine.
No card filed.

## What makes this cheap to fix

Gavin already knows how to find the log, for token accounting:
`claude_transcript` and `codex_rollout` in `app/src-tauri/src/agent_tokens.rs`,
reached through the profile's `TokenLog`. `claude_transcript` deliberately
scans every project directory for `<conversation_id>.jsonl` rather than
reproducing Claude Code's slug rule — which is undocumented, has changed, and
would be wrong for any agent that moved into a worktree. That resolver is
exactly the existence check Resume needs, per profile, already written and
already correct about the hard case.

- [x] Decide where the check belongs: the frontend asking before it builds the
      command, or the backend answering "is this binding resumable" as one
      call. The backend already holds the resolver, and the frontend already
      has to ask it something to know the answer.
      **Decided: the backend answers, as one call.** `conversation_log(profile,
      id)` in `agent_tokens.rs` returns `present | missing | unknown` off the
      same `transcript_path` resolver the token read uses, so the two can never
      disagree about where a conversation lives. Three values, not a bool:
      `unknown` (no id, a profile with no `TokenLog`, or a log root gavin
      cannot see -- `CLAUDE_CONFIG_DIR` points elsewhere) keeps today's
      behaviour and lets the CLI answer; only `missing` -- a root gavin CAN see
      that does not hold the file -- stops anything. The frontend asks it once
      per resume, before the launch wall and before anything is written, and
      fails open to `unknown` if the call itself throws.
- [x] Decide what Resume DOES when the log is missing. Falling through to
      `composeResumeTaskPrompt` silently is the "silent fresh conversation
      wearing a better name" that `resume_args`'s own doc comment warns
      against, so it should say what it is doing and why. Re-launch is the
      other honest answer — there is no conversation to lose — and today the
      human has to know that themselves.
      **Decided: Resume refuses, and the refusal names Re-launch.** A missing
      log means the agent never completed a turn, so it edited nothing: there
      is no work for the gavin-resume skill to find, and the resume prompt's
      "work on it already started" would be false. Falling through to it would
      send an agent hunting for work that does not exist under a verb that
      promised continuity. Re-launching silently from under the Resume button
      was rejected too: it is the right run, but a launch the human did not
      ask for by that name, and there is no toast to say so. So the launch
      layer returns one sentence to whichever surface pressed it (modal, card
      menu, column Resume, rail step, auto-resume's notification): the agent
      stopped before it wrote a line, there is nothing to reopen, and Re-launch
      starts the card again from the beginning -- the button that sits beside
      Resume in the detail modal. Nothing is written first: no status, no
      binding, no review sheet. A review launch is NOT refused on a missing
      log; its written fallback (`composeReviewLaunchPrompt`) is an honest
      prompt for a different action and stays as it was.
- [x] Check what auto-resume does with an unresumable binding.
      `autoResumeState.ts` reaches `resumeCard` without a human, so a doomed
      command may be retried on a timer; confirm whether it backs off or
      loops, and make it stop rather than spend an agent launch each time.
      **Checked: it never looped, and now it spends nothing.** Before the
      guard, `fire` in `autoResumeState.ts` launched `claude --resume <uuid>`
      once; the CLI exited, that new session failed, and `autoResumeDecision`
      skipped the second round on the persisted budget (`resumeAttempts`
      reaches `MAX_AUTO_RESUME_ATTEMPTS`, which is 1). One wasted agent
      launch per failure, then a stall with the wrong reason -- not a loop.
      With the guard, `resumeCard` refuses before anything is spawned;
      `fire` treats the sentence as it treats any launch error (release the
      claim, notify with `resumeSkippedBody`, no re-arm), and the budget is
      untouched because nothing was attempted. The rail path is the same:
      `resumeStep` refuses ahead of `createSessionOnRailPage`. Pinned by
      "stops, and says why, when the conversation was never written" in
      `autoResumeState.test.ts` and the unattended case in
      `cardRunActions.test.ts`.
- [x] Cover it: a binding with a conversation id whose log does not exist must
      not produce a resume command. The unit is `buildResumeCommand` plus
      whatever answers the existence question, so it is a plain module test —
      no agent and no daemon needed.
      **Covered.** `buildResumeCommand` takes the verdict as a fourth
      argument and returns null on `missing` (`cardRun.test.ts`). The
      verdict itself is pinned in `agent_tokens.rs` by
      `a_conversation_is_missing_only_under_a_root_gavin_can_see`, which
      owns its own temp directory rather than reading this machine's home,
      and its wire names by
      `the_verdict_serializes_to_the_names_the_frontend_switches_on`. The
      launch layer's refusal -- the sentence, nothing written, a review
      unaffected, fail-open when the check itself throws -- is in
      `cardRunActions.test.ts`; the rail step's in `orchestrationState.test.ts`.

## Verified 2026-09-10

Resumed with every item ticked and the Tauri crate not compiling:
`conversation_log` called a `log_root` that was never written, and
`card_run_tokens` still resolved its path inline, so the "shared resolver"
`transcript_path`'s comment promised had one caller. Added `log_root` (the
one place that names each layout's directory) and routed the token read
through `log_root` + `transcript_path`, so a conversation the existence check
reports present is one the token read can open, and one it reports missing is
one it cannot.

- `cd app/src-tauri && cargo test agent_tokens`: 11 passed, the three named
  above among them. Only the filter was run -- the crate's full suite kills
  the machine's daemon
  ([fix-app-tests-kill-the-running-daemon](./fix-app-tests-kill-the-running-daemon.md)).
- `cd app && npm test`: 5229 passed, 10 failed; `npm run check`: 0 errors;
  `npm run build`: ok. This card's four test files are all green. The ten
  failures are source-grep tests whose expected strings hardcode `\n`
  against this machine's CRLF checkout; the same ten fail at HEAD in a
  detached worktree, so they predate this card. Filed as
  [fix-source-grep-tests-on-crlf-checkouts](./fix-source-grep-tests-on-crlf-checkouts.md).

## Not this card

**Why** that 09:20 run died before writing a line is a separate question and is
not filed. It matters more on Windows than anywhere else: the launch line is
POSIX-quoted and runs through Git for Windows' `sh.exe` under ConPTY, which is
the load-bearing assumption of
[the windows port card](./feat-windows-port-on-a-windows-machine.md) and has
never been proven on a Windows machine. This card is about the guard, which is
worth having however that turns out — an agent can die at launch on any OS.
