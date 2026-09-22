---
title: TypeSafe change attribution: say which card a change in a shared checkout was made for
status: Done
priority: medium
complexity: complex
---
Gavin attributes a change to a card by baseline sha alone. `next_baseline` (`app/src-tauri/src/git/runchanges.rs`) bounds a run's window at the next run's launch, and says of the case it cannot handle: "Two runs launched from the same commit are measured identically ... nothing here can say which of them wrote what." Concurrent cards in one checkout are that case, and they are this repo's normal state. The consequences are on screen today: Run Changes lists other sessions' files as this run's, the Review tab clusters cards on collisions that are only co-tenancy, and the discard prompt has to warn "Anything another run put in this checkout goes with it" (`runChanges.ts` `discardPrompt`) without being able to name what.

Measured in `plans/done/typesafe-experiments-round-2.md` on 86 cards / 592 changed files labelled by git history: in a five-card tree a card's change list is 17% its own files. One TypeSafe (`jev-1.13.0`) Choice per changed file -- state `{change: {path, diff}}`, options = the cards live in that checkout + `none` -- names the right card for 85% of files from the card TITLE alone (TF-IDF: 72%), 91% with the card's plan text. At `confidence >= 0.75` it attributes 66-76% of files and is right on 96-100% of those; a foreign file is recognised as nobody's 88-98% of the time. ~$0.0001 and 0.3s per file.

Design rules (hold these, they are the point):
- **Opt-in, off by default, and its own switch.** This sends SOURCE CODE (a diff excerpt, <= 70 lines per file) and card titles/bodies to api.typesafe.ai -- a bigger step than round 1's screen tail, so it does not ride on that toggle. The setting's copy says exactly that.
- **A hint, never a filter.** Attribution annotates the list baseline diffing produced; it never removes a file from it and never changes what `discard_run` resets. Any error, timeout, missing key, `none`, or `confidence < 0.75` leaves the file unattributed, which is today's answer.
- **Only when there is a question to ask.** Run it only for a run whose window overlaps another card's run in the same checkout (same root, a peer whose baseSha equals this one or is not an ancestor bound). A lone run in its own worktree costs nothing.
- **The questions are the E4 set in the experiment record**, verbatim: neutral option keys shuffled per request, each option the card's `{title, description}` (description = body up to 600 chars, cut at the first after-the-fact heading), plus `none`. Keep the Choice; the per-card Noul measured worse. Pin `jev-1.13.0`.

Notes (2026-09-22), for whoever reads the tree against this card:
- Built on `typesafe/turn-verdict` (fast-forwarded onto it, not merged): `typesafe.rs` gained a `Feature` gate, so `typesafe_attribution` stands behind its own `change_attribution` switch and never the verdict's -- one client, two consents. The Settings section is now "TypeSafe" with both switches over the one key.
- `RunChanges` gained `laterBaselines` (every peer baseline that descends from the run's, nearest first) beside `untilSha`: the frontend cannot do ancestry, and a bounded window's co-tenants are exactly the peers NOT in that list. The unbounded Changes view sends no peers, so there every run in the root is a co-tenant.
- Answers are cached per (checkout, path, option set, excerpt), so the same-baseline case asks each question once for all its cards, and Refresh re-asks only files whose diff moved.
- `reviewBoard.ts` carried a literal NUL character in its clustering key, which made git treat the file as binary; it is `\u0000` now and the file diffs as text again.
- The two new commands are classified in `commandGate.test.ts` beside the turn-verdict ones; that test still names `detect_agent_binaries`, which predates both branches.

- [x] Read `docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md` -- method, known misses (shared files read as `none`; a title that says nothing cannot be matched; one owner per file is assumed), the exact question set
- [x] Depends on the host command, key storage and settings plumbing in `typesafe-turn-verdict.md` (its `typesafe.rs` curl-over-stdin command and key decision). Land or share that first; do not build a second client
- [x] Pure module `app/src/lib/cards/changeAttribution.ts`: picks the co-tenant cards for a run from the board's `CardSession` bindings, builds one request per changed file, applies the policy above, returns `{path -> {card, confidence} | unattributed}`. Unit tests from recorded responses, including: a foreign file stays unattributed, a low-confidence verdict stays unattributed, a run with no co-tenant asks nothing
- [x] Diff excerpts: reuse `git_diff_since` per file, truncated in the pure module (70 changed lines / 2600 chars, headers stripped). Skip binaries, lockfiles and images in code
- [x] Consumer 1, Run Changes modal: a file attributed to ANOTHER card carries that card's title as a muted chip; the summary line gains "N look like another card's"
- [x] Consumer 2, discard prompt: when any file is confidently another card's, `discardPrompt` names them in a line of their own ("3 of these look like <card>'s work: a.ts, b.ts, c.ts") above the existing co-tenancy warning. The reset itself is unchanged
- [x] Consumer 3, Review tab: `groupCandidates` in `reviewBoard.ts` does not bind two cards on a file that is confidently only one of theirs; the group hint says when a collision was set aside this way
- [x] Settings: its own toggle under the TypeSafe section, copy naming what is sent (diff excerpts, card titles and bodies) and where
- [x] Not in scope, record on the card if it comes up: per-hunk attribution for a file two live cards both edited (not measured) -- did not come up; `changeAttribution.ts` states the one-owner-per-file assumption in its header
- [x] Checks: `cargo test --workspace`, `cd app && npm test && npm run check && npm run build`; static pre-flight of the new strings; the rendered pass is the owner's
