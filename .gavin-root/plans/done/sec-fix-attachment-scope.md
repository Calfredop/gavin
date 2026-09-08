---
kind: task
title: [sec] confine attachments to the workspace or confirm
status: Done
priority: high
complexity: moderate
---
**Severity:** High. Finding **R2** in `docs/security/README.md` (source AG-02 in `03-agent-surface.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `attachments:` frontmatter accepts any absolute path and gavin hands the file's contents to the agent at launch. A cloned card therefore makes a fresh agent read any file the developer can read (reproduced against a throwaway workspace with a file outside it). Relative paths already resolve against the workspace root; the absolute form is the gap.

**The fix.** In the pure attachments module (`app/src/lib/attachments.ts` and the host resolver that reads the files):

1. Resolve every entry, canonicalize (symlinks followed), and classify it: inside the workspace root or one of its extra contexts, or outside.
2. Outside entries are not read silently. They are listed by name in the first-Run review (`sec-fix-first-run-review.md`) and require that confirmation; until then the prompt carries the path and a one-line note that it was withheld, so the agent knows the card named it.
3. Refuse `..` components and paths under `~/Library`, `~/.ssh`, `~/.aws`, `~/.config` outright with a visible reason, whatever the confirmation says.
4. Unit tests for each class, including a symlink inside the root that points outside it.

Do not change the card format; the `attachments:` line stays as documented.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
