---
order: 14336
labels: needs-triage
title: [contrib] Evaluate and merge the ManoloZocco fork
status: To Do
priority: medium
complexity: complex
---
Gavin's first active fork is https://github.com/ManoloZocco/gavin (created 2026-10-22). This card covers deciding what to take from it and how to land it.

**What the fork holds (as of 2026-10-23):**

- `main`: 29 commits, 149 files, +14,089 / −202, about 4.1k of it tests. It is a "learning curve" pass: the research audit `docs/research/2026-10-22-curva-di-apprendimento.md` (in Italian), the plan `learning-curve.md` and cards `lc-01`…`lc-12`. It adds the effective agent config, `gavin_get_effective_config` + `gavin_doctor`, a `[worktree] setup` proposal and writer, a shared-checkout guard with per-path commits, rail conflict holds, and agent tabs flagged when they lack gavin tools. **Protocol v78 → v81.**
- `claude/vigilant-fermi-4cj7hi`: already fully contained in his `main`.
- `claude/friendly-planck-h8l367`: 1 commit, an Italian user guide `docs/guida-gavin.md` (526 lines) plus a README link.
- Based exactly on `0b57a586`, so it fast-forwards today. That stops being true once other sessions land commits, so evaluate soon.
- Fetch it read-only: `git fetch https://github.com/ManoloZocco/gavin.git '+refs/heads/*:refs/remotes/manolo/*'`

**Before any code review:**

- [ ] Decision: how to handle copyright on outside contributions. The repo is PolyForm Noncommercial with one copyright holder; merging code with no CLA leaves the contributor owning their part, which can block relicensing or selling commercial licences later. Options: a CLA in `CONTRIBUTING.md`, a written licence grant from the contributor, or accept no-CLA contributions.
- [ ] Add `CONTRIBUTING.md` that matches that decision, covering the CLA, the commit message rules (no agent attribution, `type(scope): summary` plus a why-body) and one PR per card
- [ ] Ask the contributor to open PRs against `Calfredop/gavin`, split per card or small card group, plus the docs branch as its own PR, so `ci.yml` runs on each

**Evaluation (per PR, in a detached worktree, never the shared tree):**

- [ ] `git worktree add --detach ../gavin-review-manolo manolo/main` and run the four check lines from CLAUDE.md there, plus the protocol and companion-core `wasm32-unknown-unknown` checks
- [ ] Protocol v79–v81 review against the Traps. Every widened request needs a `FEATURE_MIN_VERSION` entry in `daemonCompat.ts` **and** a `featureBlockedReason` consumer on each surface that produces it. Every new column needs its own `ALTER TABLE` and a `pre_v*` test. Check the shared `config.json`/SQLite shapes stay readable by a v78 daemon, and that no other in-flight work claims v79–v81 (renumber if so).
- [ ] `/code-review` of each PR against `origin/main`, Standards (CLAUDE.md, thin `.svelte` over pure `.ts`) and Spec (each `lc-*` card's intent)
- [ ] Product call: do the `lc-*` cards fit the PRD? Decide which to take, change or decline
- [ ] Decide what to do with the Italian docs: keep as-is, translate, or link from the README only

**Landing:**

- [ ] Squash or rebase each accepted PR with the **contributor as author** (28 of the 29 commits are authored `Claude <noreply@anthropic.com>`, against the repo's attribution rule), and messages rewritten to the repo's format
- [ ] File the cards the merge brings (`lc-*`, `learning-curve.md`) into this board, or drop them if their work is already reflected
- [ ] Human test: after the rebuild and restart onto v81, both the release and dev daemons come up, and the new surfaces (effective config, doctor, worktree setup proposal, the no-gavin-tools tab mark) show in the isolated app harness (`HOME=/tmp/gvh`)
- [ ] Remove the `refs/remotes/manolo/*` refs and the review worktree
