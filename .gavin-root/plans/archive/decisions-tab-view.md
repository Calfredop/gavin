---
order: 10240
kind: task
title: "Decisions tab: the hub tab itself"
parent: tb-developed-feat-decisions-tab.md
status: Done
complexity: complex
---
Build the Decisions hub tab. Read the parent plan,
`tb-developed-feat-decisions-tab.md` in this card's own folder, first — its
"Settled in the interview" section is the design, and it is not yours to
re-decide. This needs the sibling `decisions-tab-wire.md` in the tree:
if `humanItems` is not in `app/src/lib/core/gavin.ts`, stop and say so.

- **Pure module** in a new `app/src/lib/decisions/` folder (registered in
  `sources.ts`), with unit tests. It builds the subjects: card rows with
  their items and the bound session's attention reason; waiting sessions
  with no card, from `attentionInbox` narrowed to this workspace the way
  `nextWaiting.ts` narrows it; rail gates from `stepAttentions`'
  `review`; unreviewed cards from `unreviewed`. A card with items whose
  session is also asking is ONE row. Longest wait first; failed tests
  counted apart from waiting-on-you. It also owns the resolve payloads
  and the text of the notify message.
- **`DecisionsHubView.svelte`**, thin: the list on the left; the selected
  subject's items with their answer controls on the right, and
  `ReviewAgentPane` (Session | Plan) reused as-is below them.
- **Registration.** `HUB_VIEW_META` between Tools and Review,
  `requiresRoot`; `workspaceViews.ts` with an icon; `hubViewAttention`
  lights the tab whenever anything waits. Update the ⌘-digit and
  tab-prefs tests.
- **Actions.** Answer / Pass / Fail call `ResolveHumanItem`, then
  `QueueInput` to `cardSessionFor(card)` when that session is live and
  not interrupted (follow `queuedInput.ts`'s refusal rules). "Fail and
  close" asks first through `askConfirm`. A rail gate offers
  `skipStep` / `markStepDone`; an unreviewed card opens the card's
  review.
- **Gate.** A `FEATURE_MIN_VERSION` entry for human items with a
  `featureBlockedReason` consumer on the answer controls: an older daemon
  still lists sessions and gates, and says why items cannot show.
- **Traps** (CLAUDE.md): WKWebView, not Chromium; `$state` proxy
  identity; no native dialogs; synchronous Tauri commands block the UI.

Done when `cd app && npm test && npm run check && npm run build` are green
against a clean-HEAD baseline, plus a static pre-flight grep of the exact
strings the change relies on. The rendered pass is the owner's: file it
on this card as `Human test:` items — through `gavin_request_human`, or by
hand in the marker spelling if the MCP is down.

## Checklist

- [ ] Human test: the Decisions tab sits between Tools and Review, wears the gavel, and ⌘ 6 opens it — and hiding or dragging it in Hub tabs… sticks across a relaunch
- [ ] Human test: with something waiting, the tab wears the attention mark and its hover text reads "Something here is waiting on you", not the Orchestration tab's sentence about a rail
- [ ] Human test: a card carrying a `Decision:` line lists as ONE row even when its agent is also asking; picking an option and pressing Answer ticks the line on the card, writes `Answer (date):` under it, and the bound agent receives exactly one queued message
- [ ] Human test: on a `Human test:` item, Pass ticks it; Fail leaves the box unticked and the row reads "failed · with the agent"; Fail and close asks first in gavin's own modal (never an OS dialog) with focus on the dismissing button
- [ ] Human test: answering a card whose agent has exited says so on screen ("Answered on the card. The agent was not told: …") rather than silently sending nothing
- [ ] Human test: a rail parked on a `review` step lists as a gate, and Skip the step / Mark it done each move that rail on — including a rail that rule 5 had paused
- [ ] Human test: an unreviewed card's row opens that card's own review sheet through the Plan pane, showing the same prompt a launch would send
- [ ] Human test: the tab's two head bands line up with the Review tab's, the list and the items column each scroll inside themselves, and nothing scrolls sideways with the window narrowed to a phone-ish width
- [ ] Human test: against a pre-v42 daemon the tab still lists waiting sessions and rail gates, and says why decisions and human tests cannot be shown instead of drawing an empty list
