---
kind: plan
title: "[sec] Hardening notes from the 2026-10-15 security audit"
status: To Do
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Defence-in-depth notes from the 2026-10-15 security audit (run-1). None of these is a finding. Each is a place where the code holds today but rests on one control, an operator's care or an assumption nobody enforces, and a small change would add a second.

The hunters recorded 224 distinct notes. They are collected in `results/hardening-all.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo; each entry is a `unit` (the coverage unit it came from) and a `note`. The audit card is `review-security-audit-2026-10-15.md`.

REPORT.md §5 highlights ten of them. Seven are the child cards of this plan:

- `sec-hardening-push-gateway-tls-affirmation.md`
- `sec-hardening-loopback-publish-ports.md`
- `sec-hardening-windows-pipe-shutdown-races.md`
- `sec-hardening-serve-connection-device-refusal.md`
- `sec-hardening-review-digest-launch-frontmatter.md`
- `sec-hardening-windows-cmd-shim-refuse-specials.md`
- `sec-hardening-review-rules-trust-digest.md`

The other three ride on fix cards that touch the same code, so they are done there rather than here:

- Drawing C0 and invisible characters visibly in the review sheet's `<pre>`: `sec-fix-paste-envelope-neutralise-esc.md`.
- Passing `with_follow_symlinks(false)` to the Linux watchers: `sec-fix-linux-watchers-no-follow.md`.
- Making `relaunchCard` refuse a stored command that no gavin launch could have built: `sec-fix-relaunch-review-gate.md`.

## Taking more from the list

The other 214 notes are not swept into this plan, and they should not be worked through as a batch. A note is one hunter's observation against one tree, many repeat each other across units, and some are already moot. When one of them becomes worth doing, because it sits in code you are about to change or because something new leans on the assumption it names, pull that one entry out of the JSON, re-read the code it cites in the current tree, and file it as a new child of this plan (`kind: task`, `parent: sec-hardening-2026-10-15.md`, no `status:` line, title prefix `[sec-hardening]`) with the same shape as the seven above: what, why, where, the smallest change, a test, and "Done when".

## Done when

- Every child card is in Done, or has a dated "## Comments" entry saying why it was dropped.
