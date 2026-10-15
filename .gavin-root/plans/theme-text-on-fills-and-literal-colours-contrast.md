---
order: 24576
kind: task
title: Theme: white on the accent fills, and 127 desktop text colours outside the text roles, are unmeasured for contrast
status: In Progress
priority: medium
complexity: moderate
---
Found while fixing `companion-muted-text-fails-contrast-in-both-themes.md`. That card holds every text role in `app/src/lib/ui/theme.css` at 4.5:1 (WCAG AA, text under 18px) against every `--surface-*` of both themes (`app/companion/src/companion/seam/themeContrast.test.ts`), and holds the phone (bundle surfaces, the hub, and every desktop component they draw) to painting text only in those roles. Two things stayed outside it.

**1. `--text-inverted` on the coloured fills.** theme.css says the fills "stay mid-to-dark in both themes", so white is right on both. Computed from theme.css today:

| fill | dark | light |
|---|---|---|
| `--accent` (#4a9eff, both) | 2.75:1 | 2.75:1 |
| `--danger` | 3.84:1 (#e0524a) | 6.00:1 |
| `--warning` | 2.21:1 (#d9a648) | 5.14:1 |
| `--success` | 1.94:1 (#8bc98b) | 6.20:1 |

So every primary (accent-filled) button with white text is 2.75:1 in both themes, and the dark theme's warning and success badges are near 2:1. The theme guard leaves `--text-inverted` out by name (`OFF_SURFACE` in themeContrast.test.ts), pointing here.

**2. Desktop components that colour text outside the text roles.** Run `untextedColours` from `app/companion/src/companion/testing/textColours.ts` over every `$lib` component: 127 declarations in 28 files, 7 of them a fill role (`color: var(--accent)` and the like), the rest literal greys from the dark theme (`#888`, `#999`, `#ccc`) that read 3.5:1 or worse, down to near invisible, in the light theme. Most of them: AgentStep 12, AgentChangeWizard 12, PrdStep 10, HeadroomControls 9, GitStep 8, MemoryStep 8, AgentSkillsControls 7, IntegrationStep 7, AgentArmWizard 7, AgentSkillsStep 6, HeadroomStep 6, ReviewStep 5, WorkspaceCreateModal 5, and 15 more files with 1 to 3 each. The setup wizard's steps account for most of it.

**To do.**
- Decide the fills: darken `--accent`, `--warning` and `--success` (dark) until white clears 4.5:1, or move button and badge text onto a dark ink. This is a visible change to the brand blue, so it is the owner's call.
- Move the 127 declarations onto text roles (`--text`, `--text-muted`, `--text-subtle`, `--*-text`).
- Extend the guard to the whole desktop: `untextedColours` over all `$lib` components (it runs in the Companion suite, which can read theme.css as text; the desktop suite cannot), plus a held pair for `--text-inverted` on each fill.

**Progress (2026-10-12).**
- All 127 declarations are on text roles. `themeContrast.test.ts` sweeps every `$lib` component ("the desktop's text"); the only exceptions are WindowControls' platform glyphs, named in `PLATFORM_COLOURS`.
- `--text-inverted` is gone. Each fill has its own ink instead: `--on-accent`, `--on-success`, `--on-warning`, `--on-danger`. Every text-on-fill now uses them: ToolRunDialog and ToolsExplorerView primary, SshWorkspaceModal connect, the ArchiveGrid tick, and the GitConflictView badge.
- New guard `inklessFills`: a rule that paints a fill and colours its text must use that fill's ink.
- The theme test computes each ink on its fill in both themes. The pairs still under 4.5:1 are listed by name in `PENDING_FILL_DECISION` (blue in both themes; dark red and dark green). A second test fails the moment one of them passes, so the list has to shrink along with the decision.
- Bug fixed on the way: the conflict badge drew near-black on the light theme's amber (#a15c2f) at 3.39:1, because its comment wrongly said amber is light in both themes. `--on-warning` is now near-black in dark (7.87:1) and white in light (5.14:1). The active badge is marked with a ring instead of a lighter amber, which white could not sit on.
- Applying the decision: **A** means pointing `--on-accent` (both themes) and the dark `--on-success` and `--on-danger` at `--grey-0`. **B** means changing `--blue-3`, `--green-4` and `--red-3` (and checking every other use of those ramp steps). Then empty `PENDING_FILL_DECISION`.

**Acceptance.**
- [ ] White (or whatever goes on a fill) clears 4.5:1 on every fill in both themes, held by the theme guard
- [x] No `$lib` component colours text outside the text roles, held by a guard
- [x] Decision: Text on coloured fills (primary buttons, badges, checkbox ticks) is white at 2.75:1 on the blue and ~2:1 on dark-theme amber/green. How should it clear 4.5:1? (A) keeps every fill colour as it is and gives each fill its own ink: near-black #1a1a1a on blue in both themes (6.3:1), and on dark-theme red/amber/green (4.5/7.9/9.0:1); white stays on light-theme red/amber/green (6.0/5.1/6.2:1). (B) keeps white text and darkens the fills: blue #4a9eff→#0070f2 in both themes, dark amber #d9a648→#996e20, dark green #8bc98b→#3e853e, dark red #e0524a→#db372e. That also darkens the bars, LEDs and focus rings that use these colours.
  Options: A) A: per-fill ink, fills unchanged (dark text on the blue button) B) B: darken the fills, keep white text
  Answer (2026-10-15): A: per-fill ink, fills unchanged (dark text on the blue button)
- [ ] Human test: In a Git merge conflict in the light theme, the conflict number badges read white on amber, and the active one shows a thin ring instead of a lighter amber; in the dark theme they stay dark on amber with the same ring
