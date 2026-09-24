---
kind: task
title: "[ci] promote npm test to a gate in the Windows job"
status: Done
priority: medium
complexity: trivial
labels: windows
---
Filed by the 2026-09-22 board audit. `.github/workflows/ci.yml`'s `windows`
job (`ci.yml:115`, "Windows (compiles)") runs three steps with
`continue-on-error: true`: `cargo test` twice (`:164`, `:180`) and `npm test`
(`:197`). Only the `cargo check` steps, `npm run check` and `npm run build`
are gates.

**Promote `npm test` (`ci.yml:196-199`), and only that one.** Its own
comment already states the trigger — *"Promote it once the app suite is
green on main"* — and that condition is met: vitest is green on `main` (281
files / 6184 tests) and has been since 2026-09-22, recorded both on
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§1 and in the machine's own baseline notes. Drop the `continue-on-error`
line from that step and nothing else.

**Do not touch either `cargo test` step.** Both are still legitimately red
on Windows and promoting them would turn CI permanently red:

- `cargo test --workspace -- --skip gavin::` carries four known non-port
  failures — three `protocol` XDG tests and one `gavin-mcp` path-separator
  test — which are
  [fix-windows-suite-baseline-reds](./fix-windows-suite-baseline-reds.md);
- `gavin::` itself is 10 red, deterministically, which is
  [the gavin::tests card](./gavin-tests-is-10-red-on-windows-and-this-card-s-filter-is-why-nobody-had-seen-it.md).

Those two cards are what unblock the `cargo test` promotions. When they land,
come back and promote the `cargo test` steps in the same shape — that is the
whole reason this card is small and separate rather than folded into either
of them.

Checks: this changes CI only, so the proof is the workflow file itself plus
one push that exercises the job. Run `cd app && npm test` locally first so
you are not promoting a step you have not seen pass on this machine. Commit
only `.github/workflows/ci.yml`.
