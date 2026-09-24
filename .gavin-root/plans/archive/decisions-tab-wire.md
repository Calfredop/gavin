---
order: 11264
kind: task
title: "Decisions tab: the wire half (protocol, daemon, gavin-mcp)"
parent: tb-developed-feat-decisions-tab.md
status: Done
complexity: complex
---
Build the wire half of the Decisions tab. Read the parent plan,
`tb-developed-feat-decisions-tab.md` in this card's own folder, first — its
"Settled in the interview" section is the design, and it is not yours to
re-decide. Scope: `crates/protocol`, `crates/daemon`, `crates/gavin-mcp`
and the Tauri host (`app/src-tauri`) plus the TS mirrors and `backend.ts`
wrappers the app will call. No hub UI — that is the sibling card
`decisions-tab-view.md`.

1. **Parse.** While scanning cards, the daemon reads checklist lines that
   carry a marker — `Decision:`, `Human test:`, and the legacy
   `Human:` / `Human, …:` / `Owner…:` / `Manual …:` as tests — into
   `PlanFileInfo.human_items`: kind, text, done, options (from an
   indented `Options:` line), the latest answer / result / re-arm line
   and the state it implies (open / failed / answered / passed), and the
   line text the write guards match on. A line inside a code fence is
   not an item. The TS mirror in `app/src/lib/core/gavin.ts` is optional
   (`humanItems?`): absent from an older daemon means "unknown", never
   "none" — the `attachments` / `modifiedAt` pattern.
2. **`Request::FileHumanItem`** appends the marker line to the card's
   checklist (creating a checklist if the card has none). Re-filing an
   identical test whose last result is a failure appends
   `Ready for re-test (date)` under it instead of a duplicate line.
3. **`Request::ResolveHumanItem { path, expected_text, outcome }`**,
   outcome one of answer (text) / pass / fail (note) / fail-and-close
   (note). Writes the `Answer (date): …` or `Result (date): …` line under
   the item and ticks it; a plain fail stays unticked. Refused when
   `expected_text` no longer matches the line — the same guard
   `SetChecklistItem` uses.
4. **Protocol bump** to the next free version. Main is at 41 as of
   2026-09-22; if another branch takes the next one before this lands,
   renumber. `min_version_for` entries for both new requests; roundtrip
   and shape tests.
5. **gavin-mcp.** `gavin_request_human(card, kind, text, options?)` maps
   to `FileHumanItem`, and the request joins `claim_target` so the filing
   session claims the card.
6. **Tauri commands and `backend.ts` wrappers** for both requests. Do NOT
   add a `FEATURE_MIN_VERSION` entry here: its consumer is in the view
   card, and an entry without one is a dead gate.

Done when `cargo test --workspace` is green — re-run the daemon's
`gavin::tests` module alone before calling a failure a regression — with
tests covering every marker spelling, options, answer/result/re-arm
lines, the code-fence exclusion, both writes, a stale `expected_text`,
the re-arm, and the MCP tool. Verify MCP behaviour against an isolated
daemon under a temp `$HOME`, never the shared one; the bump only takes
effect after the human rebuilds and restarts.
