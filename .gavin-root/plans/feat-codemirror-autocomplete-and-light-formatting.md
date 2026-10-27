---
order: 5120
kind: plan
title: CodeMirror: autocomplete + light formatting
status: In Progress
complexity: moderate
---
<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

Keep CodeMirror. Do not add Monaco, Prettier, an LSP, or "run the project's formatter."

Wire light editing help into the existing `createEditor` / `FileEditor` path (Files, Plans, PRD, Review, Companion Files, and git conflict panes that call `createEditor`).

- [x] Enable `@codemirror/autocomplete` with the language packs' built-in completions (as-you-type + explicit trigger). Theme the completion UI to app tokens. Cover with unit tests where the seam allows.
- [x] Add a small curated set of snippets on top of those completions for the languages already lazy-loaded (at least js/ts, rust, python; markdown only if snippets earn their keep).
- [x] Turn on close-brackets and indent-with-tab / language-aware indent so Edit mode feels like a normal code editor.
- [x] Add a Format document action for cheap/safe formatters only (JSON pretty-print required; other languages only if equally tiny and safe). Expose it with a clear chord or control next to save. No Prettier in the bundle.
- [ ] Human test: In the running app, open a `.ts` and a `.json` in Edit — completions and a snippet insert; brackets/indent behave; Format tidies the JSON; Plans markdown still edits normally; Companion Files still opens and edits without zoom/layout breakage.
