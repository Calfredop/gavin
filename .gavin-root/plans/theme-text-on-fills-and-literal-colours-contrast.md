---
kind: task
title: Theme: white on the accent fills, and 127 desktop text colours outside the text roles, are unmeasured for contrast
status: To Do
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

**Acceptance.**
- [ ] White (or whatever goes on a fill) clears 4.5:1 on every fill in both themes, held by the theme guard
- [ ] No `$lib` component colours text outside the text roles, held by a guard
