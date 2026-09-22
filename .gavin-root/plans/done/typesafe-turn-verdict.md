---
order: 11264
title: TypeSafe turn verdict: tell a finished turn from a question, a blocker or a failure
status: Done
priority: medium
complexity: complex
---
When an agent session goes quiet, gavin decides "the turn ended" from silence plus one substring (`API Error:`, claude-code only). Measured in `/Users/coalpila/CloudStation/Coding/gavin/.gavin-root/plans/done/typesafe-experiments.md`:

- a question asked in PROSE ("Which do you want?", "Say go and I'll write it") has no bell, so it reads as a finished turn. A rail's `agent` tool step completes on it (`orchestration.ts` `agentTurnEnded`) and the follow-up queue delivers into it. On 70 real turn endings from this repo, today's rule caught 0 of 16 questions/approval gates.
- codex, gemini, cursor, opencode and custom have NO failure patterns, so every broken turn of theirs reads as finished.
- a failure's cause comes from a substring table; on 16 real Claude Code errors it named 5.

A TypeSafe (`jev-1.13.0`) second opinion on the screen tail, one ~0.7s request per quiet transition, measured: real questions caught 15/16 with 3 false flags out of 44 finished turns; synthetic screens across five CLIs 52/53; real failures recognised 16/16 and right cause 15/16. About $0.00007 per verdict.

Design rules (hold these, they are the point):
- **Opt-in, off by default.** It sends a session's screen tail (last ~40 rows) to api.typesafe.ai. Only sessions behind a rail step or a card run, never a bare terminal. The setting's copy says what leaves the machine.
- **A second opinion, never a replacement.** The daemon's status and `failure_verdict` stay exactly as they are. Any error, timeout (2s), missing key or low confidence falls back to TODAY's answer, so turning the feature on can only refine a verdict.
- **Policy in code, raw judgments kept.** `still active` Noul >= 0.7 -> treat as working; verdict confidence < 0.75 -> today's answer; a cause may drive auto-resume only at confidence >= 0.9, and the one-attempt budget (`MAX_AUTO_RESUME_ATTEMPTS`) is untouched. "Unknown never resumes" still holds: a low-confidence cause IS unknown.
- **The questions are the v2 set in the experiment record**, verbatim: `verdict` Choice (finished / asking / blocked / failed / working, with the optional-offer boundary written into `finished` and `asking`), `cause` Choice (suspend / network / outage / usage-limit / auth / crashed / none), Nouls `n_active`, `n_asks`, `n_broke`, `n_done`, `n_optional_offer`. Pin `jev-1.13.0`, not `jev-latest`: the thresholds above were measured on it.

<<<<<<<< HEAD:.gavin-root/plans/archive/typesafe-turn-verdict.md
Resume notes (2026-09-22), for whoever reads the tree against this card:
- The verdict stores and the driver are two files. `turnVerdictState.ts` holds `turnVerdictById` and the settings mirror and imports nothing that imports it back; `turnVerdictDriver.ts` reads `orchestrations`/`kanbanState`/`layoutState` and is started from `initOrchestrationListeners` by dynamic import, beside auto-resume. One file did both and closed a static cycle (`layoutState` -> driver -> `orchestrationState` -> `layoutState`), which broke two unrelated test files' module mocks and would have left `turnVerdictById` undefined at `derived([...])` depending on which view imported first.
- The driver reaches the status stream through a new `setSessionStatusHook` on `layoutState`, fired BEFORE `layoutState.update` in `handleSessionStatusChanged`: the scheduler reads the verdict map synchronously on that emission, so a pending entry set afterwards lost the race and the step was marked done anyway.
- Auto-resume decides on the failure hook, which fires before any verdict can land. It now waits for a pending entry (`whenTurnVerdictSettles`, bounded by the driver's backstop) only where the profile table said `unknown`; every other failure decides synchronously as before.
- `queueTargetFor` takes the verdict ENTRY rather than a session id, and every view passes `$turnVerdictById[id]`, so the compose refusal re-derives when the answer arrives a second after the status.

========
>>>>>>>> origin/main:.gavin-root/plans/done/typesafe-turn-verdict.md
- [x] Read `/Users/coalpila/CloudStation/Coding/gavin/docs/superpowers/specs/2026-09-21-typesafe-turn-verdict-experiment.md` (absolute: it is uncommitted in the main checkout, so a worktree has no copy; copy it into this branch's `docs/superpowers/specs/` as part of this work) -- method, known misses, and the exact v2 question set to copy into the pure module
- [x] Pure module `app/src/lib/agents/turnVerdict.ts`: builds the request (state `{agent_cli, screen}`), applies the policy above, maps a verdict onto the app's vocabulary (`asking` -> StepAttention `asking`; `blocked` -> a stall carrying the agent's own last line; `failed` + cause -> `FailureCause`). Unit tests from recorded responses, including: an offer after finished work stays finished, a retry countdown under an error line stays working, low confidence returns today's answer
- [x] Screen text for a session the app may not have attached: a new daemon read request returning the rendered tail (`SessionScreen::contents()`). New Request variant -> PROTOCOL_VERSION bump + `min_version_for` + a `FEATURE_MIN_VERSION` entry WITH a consumer that skips the verdict on an older daemon (CLAUDE.md, compat gate per request type)
- [x] Host command in `app/src-tauri/src/typesafe.rs`: POST https://api.typesafe.ai/v1/systemone through curl with the config and the `Authorization` header on STDIN, the way `agent_usage.rs` does -- the key never reaches argv, and there is no TLS crate to add. Must be `async` (a sync command runs on the drawing thread). Retry 429/529 once, 2s total budget
<<<<<<<< HEAD:.gavin-root/plans/archive/typesafe-turn-verdict.md
- [x] Decide with the owner where the key lives: config.json (shared by dev and release builds, 0600) or the OS keychain. `TYPESAFE_API_KEY` in the environment is not enough: a Finder-launched app does not inherit the shell's exports
- [x] Consumers: (1) `agentTurnEnded` waits for the verdict (or its timeout) before completing an agent tool step, and does not complete on `asking`/`blocked`/`failed`; (2) `classifyFailure` takes the verdict's cause when the profile table says `unknown` or the profile has no table; (3) the attention inbox shows `asking` for a prose question; (4) the follow-up queue does not deliver into a turn judged `asking`
- [x] Settings: app-wide toggle + key field, copy naming what is sent where
- [x] Checks: `cargo test --workspace`, `cd app && npm test && npm run check && npm run build`; static pre-flight of the settings strings; the rendered pass is the owner's
========
- [x] Decide with the owner where the key lives: config.json (shared by dev and release builds, 0600) or the OS keychain. `TYPESAFE_API_KEY` in the environment is not enough: a Finder-launched app does not inherit the shell's exports -- **decided 2026-09-22: its own `typesafe.key` file beside config.json, created 0600, shared by dev and release like config.json. Not config.json itself: the whole config is loaded into the webview, and the host reads the key only when it sends a request. Settings sees only whether a key is set.**
- [x] Consumers: (1) `agentTurnEnded` waits for the verdict (or its timeout) before completing an agent tool step, and does not complete on `asking`/`blocked`/`failed`; (2) `classifyFailure` takes the verdict's cause when the profile table says `unknown` or the profile has no table; (3) the attention inbox shows `asking` for a prose question; (4) the follow-up queue does not deliver into a turn judged `asking`
- [x] Settings: app-wide toggle + key field, copy naming what is sent where
- [x] Checks: `cargo test --workspace`, `cd app && npm test && npm run check && npm run build`; static pre-flight of the settings strings; the rendered pass is the owner's

## Outcome (2026-09-22, branch `turn-verdicts`, uncommitted)

- Pure: `app/src/lib/agents/turnVerdict.ts` (question set held byte-for-byte to the spec's JSON block by a test; policy; `agentLastWords`; `overlayVerdicts`, the one overlay every consumer reads). Recorded jev-1.13.0 answers in `app/src/lib/fixtures/turn-verdicts.json`. Wiring: `turnVerdictState.ts`.
- Scope is AGENT sessions only: a card binding, a card step, or a tool step whose tool is known to be `agent`. A `command` tool's shell is never read (its log could be judged failed and stall the rail).
- Protocol v39: `SessionScreenText`, `SetQueueGate`, `ReleaseQueueGate`; agent role refused all three; `FEATURE_MIN_VERSION.turnVerdict = 39`, consumed by `verdictsUsable` (older daemon = feature off) and the Settings switch. The follow-up gate holds a queued follow-up at an armed session's idle transition until the app releases it; the daemon delivers on its own after 5s.
- Host: `app/src-tauri/src/typesafe.rs`, async, curl `-K -` on stdin, 2s budget with one 429/529 retry; re-reads the switch on every call. Key in `typesafe.key` (0600), switch in `typesafe.json`, both beside config.json.
- Consumers: rule 3b holds while a verdict is pending (idle reads `working` for up to 3s); new rule 3i stalls an agent tool step read as `blocked`; `failed` goes through rule 3d; `classifyFailure` falls back on a verdict cause (>= 0.9) only where the table is silent, and auto-resume waits (bounded) for it; the inbox and the follow-up queue view read the overlay.
- Checks: `cargo test --workspace --no-fail-fast` green except 6 daemon tests (`shell::tests` cmd-shim x5, `save_tool_accepts_every_kind_the_app_can_author`) that fail identically on a clean HEAD. `npm test`: 13 failures, 12 identical on a clean HEAD plus the same 3 suites that fail to load there (commandGate's `detect_agent_binaries`, the two WorkspaceToolsHubView guards, indicatorSurfaces' Sidebar dot, workspaceToolsActions x8); none in files this card touched. `npm run check`: the same 6 errors as HEAD (contextMenu.test, criticalReview.test). `npm run build` ok. Live: the TS-built body through the real API read F05/A10/B01/X07/W01 correctly at 305-752ms.
- Needs the owner: rebuild + restart the daemon (v39), then switch it on in Settings > Turn verdicts and paste a key; the rendered pass; the commit.
- Not in scope, still reading the daemon's raw status: the tab badge, the sidebar dot, the board card dot, and the OS "<label> finished" notification (fired at the quiet transition, before any verdict).
>>>>>>>> origin/main:.gavin-root/plans/done/typesafe-turn-verdict.md
