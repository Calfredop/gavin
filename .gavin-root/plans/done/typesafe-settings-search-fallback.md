---
title: Settings search: when no keyword matches, find the section by meaning
status: Done
priority: low
complexity: simple
---
`searchSettings` (`app/src/lib/core/settingsSearch.ts`) shows a section only when EVERY typed token is a substring of that section's hand-written keyword table. A synonym nobody listed empties the screen: "text size" misses Terminal (`Font size`, `font`), "max agents" misses Memory wall, "auto-commit" misses Cards (`Auto commit`), and the AND rule makes a natural multi-word query worse than a single word.

Measured in `plans/done/typesafe-experiments-round-2.md` on 41 plain-language queries labelled before any run: today's matcher shows the right section for 4 and an EMPTY screen for 37. One TypeSafe (`jev-1.13.0`) Choice whose options are the existing `SECTIONS` keyword tables, verbatim, picks the right section for 38/41 (top-3: 40/41), and resolves 34 of the 37 empty screens. At `confidence >= 0.5` it answers 40 and is right on 38. ~1k tokens, $0.00004, 0.3s. Caveat: the queries were paraphrases on purpose -- this measures how a synonym is treated, not how often one is typed.

Two halves; the first needs no TypeSafe and should land regardless.

- [x] No-network half: the misses above that are plain vocabulary gaps. Add the synonyms to both `SECTIONS` tables (`GlobalSettingsView.svelte`, `SettingsHubView.svelte`): text size / zoom -> terminal; max agents / concurrent / limit agents -> memory-wall; auto-commit (hyphenated) -> cards; dark mode / colour scheme -> appearance; quota / rate limit -> fallback-agent and agent-pause; upgrade / new version / beta -> updates; phone / device -> remote-access. Extend `settingsSearch.test.ts` with each
- [x] TypeSafe half, behind the toggle from `typesafe-turn-verdict.md` (what leaves the machine: the typed query and the section keyword tables -- no workspace data): only when `searchSettings(...).shown === 0`, debounced ~400ms, ask the E7 Choice from `docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md`, verbatim. Guard the async answer with a token counter, not identity (CLAUDE.md, Svelte 5 proxies)
- [x] Policy in the pure module: `none` or `confidence < 0.5` keeps the empty state; otherwise the one section is shown under a "Closest match" line so the human can see it was not a literal hit. Error, timeout (2s) or no key -> today's empty state
- [x] Unit tests from recorded responses: a literal hit never asks; an empty result asks once per settled query; a superseded answer is dropped
- [x] Checks: `cd app && npm test && npm run check && npm run build`; static pre-flight of the new strings; the rendered pass is the owner's
