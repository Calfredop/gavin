---
order: 10240
kind: task
title: "Decisions tab: the hub tab itself"
parent: tb-developed-feat-decisions-tab.md
status: To Do
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
