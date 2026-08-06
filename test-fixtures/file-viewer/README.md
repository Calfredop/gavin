# File Viewer — Manual Smoke Test

The file viewer's interactive half has **no automated coverage** — this
codebase has never had Svelte component rendering tests, and xterm's
hover/click behaviour can't be driven headlessly. Everything below has to
be checked by hand.

## Run it

```bash
cd app && npm run tauri dev
```

Then, **inside a gavin terminal pane**, from the repo root:

```bash
./test-fixtures/file-viewer/smoke-test.sh
```

That prints every test target as terminal output, which is the only place
cmd+click works — clicking a path inside a *rendered file* does nothing,
by design.

The script generates `big.txt` (2 MiB) on first run. It is gitignored.

## What to check

Hold **cmd** and click each path the script prints.

| # | Target | Expected |
| --- | --- | --- |
| 1 | `sample.md` | Opens **in a new split beside the terminal**. Real headings, styled table, blue link, code block with its own background. Tab labeled `sample.md`. |
| 2 | `sample.ts` | Syntax highlighted — keywords, strings, comments each a different colour. |
| 3 | `sample.rs` | Also highlighted (proves it isn't hardcoded to one language). |
| 4 | `plain.log` | Opens in a pane, monospace, **all one colour**. The literal `<h1>` inside must render as visible text, *not* as a big heading. |
| 5 | `big.txt` | "Too large to preview in full" notice + a working **Open externally** button. |
| 6 | `tiny.png` | Opens in Preview (or your default image app) — **not** in a pane. |
| 7 | `Makefile` | Opens in your default text app — **not** in a pane. |
| 8 | `https://example.com` | Plain click: nothing. Cmd+click: opens your browser. |
| 9 | `definitely-not-real.txt` | Hovering does **not** underline it. No dead-end click. |
| 10 | the directory path | Also never becomes clickable. |
| 11 | `./test-fixtures/…/sample.ts` | Resolves against the pane's cwd and opens. |
| 12 | `test-fixtures/…/sample.md` | **No underline** — see Known limitation below. |
| 13 | live reload | With `sample.md` open, append a line from another pane; the viewer updates within ~1s, untouched. |

## Beyond the script

These aren't path clicks, so the script can't print them:

- **Rename suppression** — double-click a *file* tab's label. It must **not**
  become an editable input. Double-click a *terminal* tab's label — it still
  must.
- **Close prompt counting** — in a pane holding one terminal **and** one file
  tab, use the toolbar's "Close Pane". The prompt must say
  "**1** terminal session will end", not 2. Closing a lone file tab must
  prompt nothing at all.
- **Persistence** — with a file tab open, fully quit and relaunch the app. The
  tab returns showing the file's *current* content, and no phantom shell is
  spawned in its place. (This is the one that would break if bootstrap's
  Attach loop or session reconciliation regressed.)
- **Drag and drop** — drag a file tab to another pane, page, and workspace. It
  should behave exactly like a terminal tab, since the tree treats both as
  opaque ids.

## Known limitation (expected, not a bug)

The path matcher requires a candidate to start with `/`, `./`, `../` or `~/`.
A **bare** relative path like `test-fixtures/file-viewer/sample.md` is not
matched as written — the regex picks up from its first slash instead
(`/file-viewer/sample.md`), which resolves to nothing, so it never becomes
clickable.

This matters in practice because tool and compiler output often prints bare
relative paths (`src/lib/foo.ts:42`). If that turns out to be worth
supporting, the fix belongs in `PATH_CANDIDATE` in
`app/src/lib/terminalRegistry.ts` — accept a bare `word/word` shape and let
`resolve_path_under_cursor` reject the false positives, which it already
does safely.

Line/column suffixes (`foo.ts:42:8`) are also not stripped — the matcher
excludes `:` from candidates, so `foo.ts` matches and the `:42:8` is left
alone. That happens to work, but jumping to the line is not implemented.

## Files here

| File | Purpose |
| --- | --- |
| `smoke-test.sh` | Prints every target as cmd+clickable terminal output |
| `sample.md` | Markdown rendering (`marked` + `DOMPurify`) |
| `sample.ts` | TypeScript highlighting |
| `sample.rs` | Rust highlighting |
| `plain.log` | Viewable but unhighlighted + HTML-escaping check |
| `Makefile` | Extensionless → opens externally |
| `tiny.png` | Image → opens externally |
| `big.txt` | Generated, 2 MiB, over the cap → truncation notice |
