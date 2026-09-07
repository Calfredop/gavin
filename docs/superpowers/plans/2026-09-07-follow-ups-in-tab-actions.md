# Follow-ups move from the terminal footer into the tab actions

The follow-up queue shipped as a band under every terminal (`FollowUpQueue.svelte`,
mounted by `TerminalPane`). Measured in real WebKit with the component's own CSS,
that band costs the terminal **32px** while an agent works with nothing queued,
**60px** with one follow-up, **112px** with three, and **171px** with three and the
compose box open — height taken off the PTY, on every terminal in the app.

It moves to where the two other "answer a question about this agent" surfaces
already live: the pane's tab-actions row, beside **plan** and **changes**, opening
**side by side** in a split.

## Decisions

- **The band goes entirely.** Not shrunk — removed. The terminal gets every row
  back, and `TerminalPane` loses the strip-visibility refit that existed only to
  tell xterm the band had taken a slice of the pane.
- **A follow-ups tab is a card tab with a third view.** `CardTabView` gains
  `"followups"` and `CardTab` an optional `sessionId`, rather than a fourth
  `*TabsById` map. A new map would have to be threaded through `sessionTabsOnly`
  and its twelve callers, `repairUnknownTabs`, the bootstrap read-back, the
  close paths, the sidebar rows and an `AppConfig` field; the card-tab map
  already carries "a view living in a pane, opened from the terminal tab it
  belongs to", and every one of those sites already treats it as a non-session
  tab. `path` is `""` for this view — `archiveClose` matches tab paths against a
  Set of real card paths and `retargetCardTabs` against an exact `from`, so
  neither ever sees it.
- **The queue is anchored to a SESSION, not a card.** That is the whole reason
  for `sessionId`: an agent's queue outlives whatever card it happens to be
  running, and two tabs on the same card have two different queues.
- **One view, two hosts.** `FollowUpQueueView.svelte` renders inside `Modal`,
  `inline` in the split pane and as a dialog from the Home tab's agent panel —
  which has no tab bar to hang an action on and is where "Send to workspace
  agent" lands, so it cannot lose the ability to queue with the band.
- **The button is always on a terminal tab**, badge only when something is
  queued. Plan and changes appear only when there is a card or a diff to show;
  this one is also the compose entry point, so withholding it would hide the
  feature.
- **No protocol change.** `set_card_tabs` is a Tauri host command and the four
  queue requests are untouched, so `PROTOCOL_VERSION` stands and the
  `queuedFollowUps` gate keeps the consumer it has.

## Checklist

- [x] `CardTabRecord.session_id` in `config.rs` (serde default, camelCase) and its
      construction sites
- [x] `CardTabView`/`CardTab` in `gavin.ts`, `cardTabLabel` in `paths.ts`
- [x] `openFollowUpsInSplit` beside `openCardInSplit`, sharing one split body
- [x] `FollowUpQueueView.svelte` — status line, composer, the queue with its four
      actions
- [x] `Pane.svelte` — the badged action, the pane render, label and tooltip
- [x] `Sidebar.svelte` label for the new view
- [x] `MainAgentPanel` — the same view as a dialog
- [x] `TerminalPane` — band and refit removed; `FollowUpQueue.svelte` deleted;
      `stripVisible` retired
- [x] Surface test rewritten for the new home; suites green
