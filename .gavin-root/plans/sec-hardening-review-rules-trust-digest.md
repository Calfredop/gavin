---
kind: task
title: "[sec-hardening] Review prompts tell the agent that a cloned repo's .gavin-root/REVIEW.md wins, and nothing records that a human has read it"
parent: sec-hardening-2026-10-15.md
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Part of `sec-hardening-2026-10-15.md`. A hardening note from the 2026-10-15 security audit (run-1), not a finding. Full record: entry 53 of `results/hardening-all.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The confirmed finding `sec-fix-card-review-launch-gate.md` names this as a separate root cause and leaves the decision to this card.

## What

Every review prompt gavin composes, the single-agent "Review with agent", the "Critical review" and the rail tools `builtin:code-review` and `builtin:critical-review`, begins: "First read `.gavin-root/REVIEW.md`. It is this workspace's review rules, and where it says something your own habits do not, it wins." That file ships with the repository. Unlike `config.toml` (`trustedConfigHash`) and cards (`reviewedCards`), it has no digest and no review. A branch review with no card in it still sends the agent to read it first.

## Why

gavin's own words raise a cloned repository's text to instruction authority over the reviewer, an agent that runs unsandboxed as the human. The agent reads repository files anyway, and the product's written promise (the first-run review, cardReview.ts) does not name repository instruction files, which is why the audit did not raise it as a finding. But "it wins" is gavin vouching for text nobody was shown. The workspace-trust and card-review gates exist for exactly this shape, one level over.

## Where (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/agents/actionPromptDefaults.ts:150-156` (DEFAULT_CODE_REVIEW): the "it wins" sentence.
- `app/src/lib/review/codeReview.ts:27-50` (REVIEW_RULES_FILE, reviewRulesPath): the fixed path under the root context.
- `app/src/lib/review/codeReviewActions.ts:125-165` (open): reads only whether the file exists (146), then raises the review dialog; `launchReview` (251) composes the prompt and creates the session; `createReviewRules` (204) is gavin's own writer of the starter file.
- `app/src/lib/review/criticalReviewActions.ts:134-137` (the same existence check) and `:223` (createCriticalReviewRules).
- `app/src/lib/orchestration/orchestrationTools.ts:723` and `:748` (builtin:code-review, builtin:critical-review): the rail tools, whose body resolves `.gavin-root/REVIEW.md` in the rail's own checkout.
- The pattern to copy: `app/src/lib/workspace/workspaceTrust.ts:102` (configTrusted), `app/src/lib/core/layoutState.ts:2294` and `:2370` (reading and stamping `trustedConfigHash`), `app/src/lib/core/workspace.ts:250`, `app/src/lib/workspace/workspaceSettings.ts:65`, and the host side `app/src-tauri/src/config.rs:445`.

## Change

Give the rules file the workspace-trust treatment. Store a machine-local `trustedReviewRulesHash` per workspace beside `trustedConfigHash` (the TS `Workspace` field, the `workspaceSettings.ts` list and the `app/src-tauri/src/config.rs` struct field). In `open()` for both review kinds, read the file instead of only testing that it exists. If it exists and its sha256 is not the stamped one, show it with `askConfirm` (title naming the file, the content in the block, buttons that name the action, `danger: true`) before the review dialog; stamp on yes, and cancel the review on no. `createReviewRules` and `createCriticalReviewRules` stamp the starter they write, so a human's own new file never asks.

For the rail tools, which run with nobody watching, read the file in the step's checkout before launching; if it is unstamped, stall the step with a reason naming the file, as an unreviewed card stalls (`unreviewedStallReason`), and let the human approve it from the Review tab or the rail.

If that turns out larger than this card should be, the fallback is in the prompt alone: drop "it wins" and say the file holds the repository's suggestions, to follow where they do not conflict with the review's own instructions. Record which one you did under a dated "## Comments" heading.

## Test

In a new `reviewRulesTrust.test.ts` and in `codeReviewActions.test.ts`/`criticalReviewActions.test.ts`: with a REVIEW.md present and no stamp, opening a review raises `askConfirm` with the file's content and declining leaves no pending request and never calls `backend.createSession`; with a matching stamp, nothing is asked; changing one byte of the file asks again; `createReviewRules` leaves the file stamped. In `orchestrationState.test.ts`: a `builtin:code-review` step on an unstamped file stalls and creates no session.

## Done when

- No review launch sends an agent to read a REVIEW.md that a human on this machine has not been shown, or the prompt no longer tells the agent that the file wins, as recorded on the card.
- The tests above exist, and the launch tests fail before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
