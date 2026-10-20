---
title: [review] security audit 2026-10-15 (whole workspace)
status: Done
priority: high
complexity: intricate
---
Second security audit of the workspace, run with the `security-audit` skill (six phases: reconnaissance, coverage-led hunting waves, candidate validation, structured findings, independent record verification, report). Standard profile, whole workspace in scope: daemon + protocol, gavin-mcp, Tauri host, SvelteKit app, Companion bundle + shell + core/wasm, Relay, push gateway, release pipeline.

Reviewed ref: `e07614ea` with a dirty tree (17 paths). The 2026-09-08 audit (`docs/security/`, commit 944eae2 / v34) predates the whole remote-access surface; its accepted-by-design list (AD-1..AD-7) still applies and gets no card.

Run directory (outside the repo): `~/security-audit-skill/gavin/run-1/` — `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`, `findings.json`, `coverage-ledger.json`.

Execution policy: source review plus bounded local checks only (isolated daemon under a temp `$HOME`, existing test suites, fixtures). Never the live daemon, never the Relay at `gavin.rs`, never a real Device.

- [x] Phase 1: reconnaissance — `architecture.md` + seeded `coverage-ledger.json`
- [x] Phase 2: hunter waves + coverage critics to a clean pass (16 waves: 53 hunters, 79 units; the post-wave-16 critic and the third final-clean critic both returned clean)
- [x] Phase 3: fresh verifier per candidate (49 records: 21 confirmed, 23 needs validation, 5 rejected)
- [x] Phase 4: `findings.json` validated against the schema; ledger validated
- [x] Phase 5: fresh-eyes verification of every retained record (44 records; 3 material replacements and 1 promotion re-verified by a fresh agent)
- [x] Phase 6: `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`
- [x] File one `sec-fix-*` card per confirmed root cause, ranked, with the fingerprint and the smallest fix (21 cards)
- [x] File the needs-validation leads, blocked units and hardening notes (29 new cards, 2 existing cards extended). Leads whose blocker was only "could not run here" are `sec-fix-*` cards whose failing regression test is the proof (15, two of them merging a pair of leads); leads that turn on a policy choice are `sec-check-*` cards holding a Decision (4). The push-allowance lead joins `sec-fix-gateway-token-proof-of-possession.md` and the orchestrate-skill lead was already on `sec-fix-organize-review-gate.md`. The two blocked units are `sec-hunt-*` cards. Seven highlighted hardening notes are children of `sec-hardening-2026-10-15.md`; the other notes stay in `results/hardening-all.json`
