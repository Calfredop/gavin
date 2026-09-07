---
title: [ui] Review tab polish
status: Done
---
Owner's three asks on the Review tab, after the terminal-escape fix
([[bug-review-tab]]) made the columns visible for the first time.

## 1. Font colours

Measured off the owner's screenshot rather than guessed. Sampling the
brightest pixel of each glyph run:

| element | rendered | should be |
| --- | --- | --- |
| unselected card title | `#2a2a2a` on `#1e1e1e` | `--text` `#eee` |
| selected card title | `#494949` on `#3a3a3a` | `--text` |
| strip's card title | `#262626` | `--text` |
| card `.meta`, group head, `REVIEWING` | `#999`/`#a1a1a1` | correct already |
| touched-file name / dir | `#f9f9f9` / `#696969` | correct already |

The pattern is exact: **every rule that declares a colour is right and
every rule that inherits one is black.** Nothing in the app sets a root
text colour — theme.css defines tokens and two base rules and stops — so
an element with no `color` of its own inherits the UA's `canvastext`,
which is black because nothing declares `color-scheme` either (theme.css
says as much in its scrollbar comment). Every other component pays for
that by naming its own colour; `BoardCard` sets `color: var(--text)` on
`.card` for exactly this reason. Four Review rules did not.

Fixed per component root rather than app-wide: a root default would
change every surface in the app off a bug report about one tab.

## 2. Session / Plan switch on the first column

The agent column shows the card's terminal. It should switch to the
card's detail panel — `CardDetailModal` with `inline`, which is what
`CardTabPane` already mounts for a "Show plan" chip, so a card never has
two different detail panels. Switch built like `ReviewFilePane`'s
Diff/Edit group so the two columns read as one control vocabulary.

## 3. Column header height and spacing

Measured in a WKWebView probe against the shipped CSS (root font-size is
13px — WebKit's default fixed size, since `:root` is `font-family:
monospace` and nothing sets a size):

| head | height |
| --- | --- |
| Agent | 20px |
| Touched files | 20px |
| File pane **with** the Diff/Edit group | 26px |
| card list's column picker row | 23px |

All four are `padding: 0 8px 6px` — **no top padding at all**, so the
19px-tall Diff/Edit group has zero pixels above it and sits on the
column's top border, which is what the owner reported. And the rules
under the four heads land on three different y positions in the
screenshot: 103, 106, 107.

One shared metric on `.review`, inherited by all four (the app already
does this for its three header rows via theme.css's `--header-*`), and a
guard test so no head goes back to a literal.

## Checklist

- [x] Colours: `color: var(--text)` on each Review component root
- [x] Session/Plan switch in the agent column, mounting `CardDetailModal inline`
- [x] One header metric, applied to all four column heads, measured to land on one y
- [x] Guard test over the shared metric
- [x] Suites green + static pre-flight

## 4. The twin of the terminal bug (found on the way)

`Modal`'s inline backdrop is `position: absolute; inset: 0` and says in
its own comment that "the host is responsible for being a positioned
box". The Session/Plan switch mounted `CardDetailModal inline` in a
static wrapper, so the card detail covered the whole tab — the same
failure as the terminal, in the same column, a day later. The owner saw
it hot-reload and said so before the commit.

`terminalPaneMount.test.ts` would never have caught it, so it became
`absolutePaneMount.test.ts` and now covers every component that FILLS its
host: the five panes plus the four Modal-inline wrappers (the guard found
`FollowUpQueueView`, which was already correct at both its call sites).
Each entry is checked against the stylesheet it claims to describe, and a
derivation underneath fails if a new single-rooted pane is written and
not listed. `BoardSelectionBar` is deliberately outside it — `bottom:
16px; left: 50%` is a bar floating over the board, which wants the
nearest positioned ancestor it can get.

The guard was itself mutation-tested: deleting either fix must name the
right component. The first attempt did NOT catch the terminal one, because
`classDeclarations` was reading CSS comments as selectors — the comment on
`.plan` says "for the same reason `.terminal` above is", which credited
`.terminal` with `.plan`'s `position: relative`. Comments are stripped now.

## What landed

Commit `6ebaac7`, 10 files. Measured against the committed CSS in
WKWebView: four column rules all at y=56 (were 51/48/48/54), both
switches 4px clear top and bottom (the diff/edit one was 0), card titles
`rgb(238,238,238)`, and the plan panel at `[280, 56, 358, 644]` inside
the agent column at `[280, 28, 358, 672]`.

Suites: `npm test` 4517 passed (202 files), `npm run check` 0 errors,
`npm run build` green. No Rust touched.
