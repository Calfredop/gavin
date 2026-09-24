---
kind: task
title: "[fix] terminal path links never match a Windows-spelled path"
status: To Do
priority: high
complexity: simple
---
`PATH_CANDIDATE` in `app/src/lib/terminal/terminalRegistry.ts:93` is
`/(~\/|\.{0,2}\/)[^\s'"()[\]{}:,]+/g`. Every alternative requires a FORWARD
slash, and `:` is excluded from the run. On Windows that gives three wrong
answers, measured against the committed regex:

| line as the terminal renders it | candidate produced |
|---|---|
| `C:\Users\Ada\repo\file.txt` | **(no match)** |
| `\\server\share\file.txt` | **(no match)** |
| `C:/Users/Ada/repo/file.txt` | `/Users/Ada/repo/file.txt` — drive letter lost |
| `C:/Users/Ada/My Documents/x.txt` | `/Users/Ada/My` — truncated at the space |
| `09/24/2026  10:12 AM  <DIR>` | `/24/2026` — false positive |

Row 1 is the one that matters: backslashes are how `cmd.exe`, PowerShell,
MSVC and most Windows tooling spell a path, so the hover underline never
appears for the ordinary case. Row 3 is the quiet one — the match starts
after `C:`, and `resolve_path_under_cursor_impl` then treats the result as
absolute, which resolves against whatever the CURRENT drive is. Right by
luck on a C:-only machine, silently wrong on any other drive.

The Rust half is not at fault and needs no change: `resolve_path_under_cursor_impl`
(`app/src-tauri/src/fileviewer.rs:284`) takes the candidate whole and handles
spaces, drive letters and UNC correctly, and `protocol::strip_verbatim_prefix`
covers `\\?\C:\`, `\\?\UNC\` and `\\?\Volume{…}` with unit tests at
`crates/protocol/src/lib.rs:5168-5178`. Everything that is broken is in the
one regex that decides what text to hand it.

What to do:

- Accept backslash-spelled paths, including a drive-qualified absolute
  (`C:\…`) and a UNC (`\\server\share\…`), without breaking the POSIX arms
  the same regex serves on mac and Linux.
- Keep the drive letter in the candidate. `:` is excluded from the character
  class to stop `file.rs:12:5` line/column suffixes from being swallowed, so
  a drive letter needs its own leading alternative rather than relaxing the
  class — removing `:` outright would regress the suffix behaviour.
- Decide deliberately what to do about spaces and say so in a comment. A
  path with a space cannot be found by a greedy non-space run; the honest
  options are to leave it unmatched (documented) or to try progressively
  shorter prefixes against the resolver. The resolver already returns None
  for anything that is not a readable file, so a wrong guess costs a
  round-trip and never produces a dead link — but each extra candidate is
  another round-trip per hovered line, which is why the current comment
  calls the regex "deliberately stricter than any word".
- Add unit tests over the regex itself for the table above. There is no test
  file for this module's tokenizer today; the five rows are the spec.

Verify with `cd app && npm test && npm run check`. Do not claim the hover
works until the owner has confirmed it in the running app — this card makes
the candidate correct, which is the half a suite can see.

Found by the static pre-flight for item 4 of
[windows-desktop-pass](./windows-desktop-pass.md) on 2026-09-24. That item
says "worth hovering a path with a SPACE in it and one on a UNC share, which
is where the two arms differ" — the two arms it means are
`strip_verbatim_prefix`'s, and neither a space nor a UNC path ever reaches
them.
