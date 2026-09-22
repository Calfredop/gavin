---
title: [fix] the last 12 vitest failures on main, and none of them is a line ending
status: Done
priority: medium
complexity: simple
---
Measured 2026-09-22 on `main` at **b724f91**, after both Windows branches
merged and the working tree was refreshed to LF: `cd app && npm test` is
**12 failed / 5739 passed across 8 files**.

This is what is left once the line-ending problem is gone.
[fix-source-grep-tests-on-crlf-checkouts](./done/fix-source-grep-tests-on-crlf-checkouts.md)
did exactly what it promised — every source-grep test it named is green —
and the residue is a different, older problem that the CRLF noise was
hiding. **None of it is Windows-specific**, so the Linux CI job fails on the
same twelve.

## Three suites never load at all

```
src/lib/cards/bestOfNActions.test.ts
src/lib/review/codeReviewActions.test.ts
src/lib/review/criticalReviewActions.test.ts
```

each dying at import with

```
Error: [vitest] No "agentDefaultsStore" export is defined on the
"$lib/core/layoutState" mock. Did you forget to return it from "vi.mock"?
 ❯ src/lib/agents/actionPromptsState.ts:25:43
```

`actionPromptsState.ts` derives `appPromptOverrides` from
`agentDefaultsStore` at module scope, so any test that mocks
`$lib/core/layoutState` without that export breaks the whole file. The fix
is either `importOriginal()` in those three mocks, or — better, since three
files made the same mistake — moving `agentDefaultsStore` out of
`layoutState` so a test mocking layout state does not have to know about
agent defaults.

## Nine individual assertions

```
workspaceToolsActions.test.ts   "an agent tool's verdict"  × 8
commandGate.test.ts             names exactly the commands lib.rs registers
orchestrationGavinTool.test.ts  WorkspaceToolsHubView.svelte draws a tool's icon …
toolPlatformGate.test.ts        darkens the Tools tab's Run button through runBlockedReason
indicatorSurfaces.test.ts       leaves no bare coloured dot outside the one place a pip is right
```

The `commandGate` one is worth doing first and is worth more than it looks:
it asserts the TS classification matches the commands `lib.rs` actually
registers, so it goes red when a command is added without being classified
— a real drift detector, currently silent because it is always red.

## Why this is worth a card rather than a baseline note

It has been carried as "the app suite baseline" in agent memory for weeks —
21 red, then 24, then 12 — which trains every session to skip past a red
suite. A suite nobody can read is a suite that cannot report a regression;
the `commandGate` test above is already an example of one that has stopped
working for its actual purpose. Related:
[fix-npm-run-check-gate-is-red-on-main](./fix-npm-run-check-gate-is-red-on-main.md),
which is the same story one command over.

**Check both CI jobs when closing.** `npm test` is `continue-on-error: true`
in the Windows job only; on Linux it is a gate, so Linux CI has been red on
these for as long as they have existed.

## Closed 2026-09-22 (`9d72df9`)

Fixed together: `npm test` is 5803 green across 265 files and `npm run
check` reports 0 errors. Details and reasoning are on
[feat-windows-port-on-a-windows-machine](../feat-windows-port-on-a-windows-machine.md)
§1 line 2 and in the commit body.
