# A view belongs to the tab that opened it, and a terminal never does

A terminal tab opens views of its own work beside itself: its card's plan, what its run changed, its follow-up queue, its browser, a file or a board. Each of them used to split the whole pane, so the view sat beside every tab in that pane rather than beside the one that opened it. Switching to another tab left the first tab's diff on screen, and the view was one more tab in the page's tree, so focusing it took the opening tab's actions away with it.

We decided that such a view is an Attached view: it belongs to the terminal tab that opened it, it is drawn as a side pane inside that tab's pane only while the tab is in front, and it is saved in the layout under that tab. The tab and its Attached views are a Tab group, and the group's header reads the tab's own, wherever focus sits inside it. A terminal is never attached. Split Right and Split Down still divide the page, because a terminal is work running alongside the others, and everything that looks for terminals (the attention inbox, the sidebar, the close confirmation, idle tabs) keeps finding them in the page tree alone.

## Consequences

- The layout's leaf carries its tabs' Attached views, so the Rust mirror of the layout (`app/src-tauri/src/layout.rs`) has to carry them too, or saving the layout from Rust drops them.
- Closing a tab closes its Attached views, and a view dragged out of a group becomes an ordinary tab that stays on screen whichever tab is in front.
- Pages saved before this keep their views as ordinary panes. Nothing in the old layout says which tab a pane belonged to, so nothing is converted.

## Considered options

- **Every tab holds a layout of its own, terminals included** (tmux-style windows). Rejected. Every walk of the layout (drag and drop, the sidebar, attention, closing) would have to descend into tabs, for a gain the human did not ask for.
- **Move the opening tab into a pane of its own before splitting.** Rejected. The tab leaves its stack, which is not the grouping the human described, and the view is still an ordinary pane that stays on screen.
