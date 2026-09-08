---
order: 5120
kind: task
title: [sec] CI on main with pinned actions
status: To Do
priority: low
complexity: moderate
---
**Severity:** Low. Finding **R9** in `docs/security/README.md` (sources SC-04, SC-05 in `04-supply-chain.md`; the audited file is filed as `04-supply-chain/ci.yml.a538312.txt`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `main` has no `.github/workflows`: no commit is built, tested, or audited anywhere but the developer's machine. The `ci.yml` on `Feat/multi-os-support` pins four third-party actions by mutable tag, declares no `permissions:`, and runs `cargo` without `--locked`. It has no `pull_request_target`, no secrets, and no artifact upload, so nothing there is dangerous today; it is just not on `main` and not pinned.

**The fix.** Land a `ci.yml` on `main` (start from the branch's) with: every action pinned by full commit SHA with the tag in a comment; top-level `permissions: contents: read`; `cargo build --locked` / `cargo test --workspace --locked`; `cd app && npm ci && npm test && npm run check && npm run build`; and a separate job running `cargo audit` and `npm audit --omit=dev` that fails on a vulnerability and only warns on unmaintained. Keep the daemon's `gavin::tests` module in a retry step, per `CLAUDE.md` (they are flaky under full-suite parallelism). Do not add release or signing steps here; that is `sec-fix-signing-and-sidecars.md`.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
