---
order: 6144
kind: task
title: [bug] review tab
status: Done
---
the freshly developed review tab is just showing an agent session, just like any other page’s tab

## Root cause

Not the tab's wiring — it renders `ReviewHubView` correctly. `TerminalPane`'s
root is `position: absolute; inset: 0`, which it has to be: `Pane.svelte`
stacks every tab of a pane on one rectangle and hides the inactive ones with
`visibility`, so they all occupy it at once. That makes "the element I am
mounted into establishes a containing block" a contract every call site owes
it. `ReviewAgentPane`'s `.terminal` wrapper did not, so the terminal was not
merely mis-sized in the agent column — it left the column entirely and took
the nearest positioned ancestor, `.view` in `+page.svelte`. That is the whole
tab, so the terminal painted over the card list, the touched files and the
diff, and nothing behind it could be clicked either.

Measured in a throwaway WKWebView probe against a replica of the exact
`.view → .review → .panes → .cols → .agent → .terminal → .pane` chain, at
1000x600:

| `.terminal` | terminal's rect |
| --- | --- |
| static (shipped) | `[0, 0, 1000, 600]` — the whole tab |
| `position: relative` | `[280, 54, 192, 546]` — the agent column |

`Pane.svelte` (`.content`) and `MainAgentPanel.svelte` (`.terminal`) both
already carried the rule; `ReviewAgentPane` was the only call site of the
three that did not. Nothing else mounted in the review columns has an
absolutely positioned root.

## What landed

- `ReviewAgentPane.svelte` — `position: relative` on `.terminal`, with the
  reason written next to it.
- `terminalPaneMount.test.ts` — a guard over the sources, sibling to
  `terminalPaneSession.test.ts`: it finds every `<TerminalPane` call site,
  walks the markup to the element it is mounted into, and requires that
  element's class to carry a non-static `position` in the same file's
  `<style>`. Failed naming `ReviewAgentPane.svelte` alone before the fix.
  No suite renders CSS, and this failure mode is invisible to every one
  that exists — the broken call site differs from the correct one by a
  single declaration in a style block nobody reads beside the markup.

Suites: `npm test` 4385 passed, `npm run check` 0 errors, `npm run build`
green. No Rust touched, so `cargo test` was not re-run.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
