import { describe, it, expect } from "vitest";
import {
  HUB_VIEW_META,
  hubViewAttention,
  hubViewAttentionLabel,
  hubViewBusy,
  orderableHubViewIds,
  tabStripHubViewIds,
  visibleHubViewIds,
} from "$lib/hub/hubViewMeta";
import { FEATURE_MIN_VERSION, featureBlockedReason } from "$lib/core/daemonCompat";
import { allSources } from "$lib/sources";

// The Decisions tab is three pure modules and two components, and the
// rules that hold them to the rest of the app are invisible to every
// other suite here. A tab registered in the metadata with no component
// is a crash at render. A version gate with no consumer is a dead gate,
// and its particular dead-gate failure is the worst one in this feature:
// a tab that reports "nothing is waiting on you" for a workspace with a
// dozen open decisions in it, which the human then believes. An answer
// control that skipped `decisions.ts` would send a payload the daemon's
// `expected_text` guard has never seen.
//
// Reads sources rather than the rendered DOM, following
// reviewSurfaces.test.ts beside it: mounting the tab needs a daemon, a
// window and a PTY, and a guard that asserts "this handler was called"
// tests the harness.

const SOURCES = allSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const VIEW = "DecisionsHubView.svelte";
const ROW = "DecisionsItemRow.svelte";

describe("the tab's registration", () => {
  it("sits between Tools and Review, and needs a root", () => {
    const ids = HUB_VIEW_META.map((v) => v.id);
    expect(ids.indexOf("decisions")).toBe(ids.indexOf("tools") + 1);
    expect(ids.indexOf("review")).toBe(ids.indexOf("decisions") + 1);
    const meta = HUB_VIEW_META.find((v) => v.id === "decisions");
    expect(meta?.label).toBe("Decisions");
    expect(meta?.requiresRoot).toBe(true);
  });

  it("draws as a tab in the strip rather than behind an action", () => {
    expect(orderableHubViewIds()).toContain("decisions");
    expect(tabStripHubViewIds(true)).toContain("decisions");
  });

  it("is not offered to a workspace with no root folder", () => {
    expect(visibleHubViewIds(false)).not.toContain("decisions");
  });

  it("has a component and an icon bound to its id", () => {
    // HUB_VIEW_META and COMPONENTS are keyed by the same ids, and a
    // missing entry is an undefined spread that crashes at render rather
    // than a compile error the id union would catch.
    const text = source("workspaceViews.ts");
    expect(text).toMatch(
      /import DecisionsHubView from "\$lib\/(?:[\w.-]+\/)*DecisionsHubView\.svelte"/
    );
    expect(text).toContain("decisions: { icon: Gavel, component: DecisionsHubView }");
  });
});

describe("the tab's attention mark", () => {
  const IDLE = { committing: false, railsWantingAttention: false };

  it("lights whenever anything in this workspace waits", () => {
    expect(hubViewAttention("decisions", { ...IDLE, decisionsWaiting: true })).toBe(true);
    expect(hubViewAttention("decisions", IDLE)).toBe(false);
  });

  // Two axes, kept apart: a rail wanting attention because its agent
  // BROKE is a fault to go and read, not a decision to take, and the
  // Decisions tab lists sessions with no rail behind them at all.
  it("is its own field rather than a roll-up of the rails'", () => {
    expect(hubViewAttention("decisions", { ...IDLE, railsWantingAttention: true })).toBe(false);
    expect(
      hubViewAttention("orchestration", { ...IDLE, decisionsWaiting: true })
    ).toBe(false);
  });

  it("never spins: nothing this tab owns runs in the background", () => {
    expect(hubViewBusy("decisions", { ...IDLE, decisionsWaiting: true, committing: true })).toBe(
      false
    );
  });

  // A strip that said "a rail is waiting on you" over the Decisions tab
  // would send the reader to the wrong tab to deal with it.
  it("says what it is waiting on, not what the Orchestration tab waits on", () => {
    expect(hubViewAttentionLabel("decisions")).not.toMatch(/rail/i);
    expect(hubViewAttentionLabel("orchestration")).toMatch(/rail/i);
  });

  it("is fed from a store rather than from inside the tab it marks", () => {
    // The tab that owns the mark is destroyed on every switch away from
    // it, so a count computed inside DecisionsHubView would exist only
    // while the Decisions tab was already on screen.
    const page = source("decisionsAttention.ts");
    expect(page).toContain("decisionsWaitingByWorkspace");
    expect(page).toContain("decisionsWaiting(list.summary)");
  });
});

describe("the version gate", () => {
  it("names the version the two human-item requests landed in", () => {
    expect(FEATURE_MIN_VERSION.humanItems).toBe(42);
  });

  // The entry alone is a dead gate (see CLAUDE.md): the gate has to
  // reach a control.
  it("has a consumer on the answer controls", () => {
    expect(source(VIEW)).toContain('featureBlockedReason($daemonCompat, "humanItems")');
    expect(source(VIEW)).toContain("blockedReason={list.itemsBlockedReason}");
    const row = source(ROW);
    expect(row).toContain("blockedReason");
    expect(row).toContain("blockedReason !== null");
  });

  it("says why the items are missing rather than drawing an empty list", () => {
    const text = source(VIEW);
    expect(text).toContain("{list.itemsBlockedReason}");
    expect(text).toContain("Decisions and human tests can't be shown:");
  });

  it("greys nothing when the app has not connected yet", () => {
    // featureBlockedReason's own rule, asserted here because this tab
    // draws its whole right-hand column from it: pre-emptively greying
    // on a null compat would make every cold start look like an old
    // daemon.
    expect(featureBlockedReason(null, "humanItems")).toBeNull();
    expect(featureBlockedReason({ daemonVersion: 41, appVersion: 42, degraded: true }, "humanItems"))
      .toContain("v42");
    expect(
      featureBlockedReason({ daemonVersion: 42, appVersion: 42, degraded: false }, "humanItems")
    ).toBeNull();
  });
});

describe("the hub view", () => {
  it("builds its list through decisions.ts rather than in the template", () => {
    const text = source(VIEW);
    expect(text).toContain("decisionsList({");
    expect(text).toContain("summaryLine(list.summary)");
    expect(text).toContain("subjectTitle(");
    expect(text).toContain("subjectDetail(");
  });

  it("re-resolves the selection against the list rather than trusting the stored id", () => {
    // Rows leave as they are answered, so a stored id routinely points
    // at nothing -- and an empty pane beside a list with plenty in it is
    // what a remembered-only selection draws.
    expect(source(VIEW)).toContain("resolveSelection(list.subjects, prefs.selected)");
  });

  it("keeps the selection outside the component that draws it", () => {
    // The hub destroys this view on every tab switch, so a selection in
    // component `$state` would forget itself on every switch away and
    // back. Same reason hubFacets.ts exists.
    const text = source(VIEW);
    expect(text).toContain("setDecisionsPrefs(workspaceId,");
    expect(text).toContain("prefsFor($decisionsPrefs, workspaceId)");
  });

  it("narrows the sessions the way nextWaiting.ts does, through decisions.ts", () => {
    // Not re-narrowed here: the tab and the ⇧⌘A button have to agree
    // about which workspace a wait belongs to.
    expect(source("decisions.ts")).toContain("workspaceWaiting(input.inbox, input.workspaceId)");
  });

  it("reads the attention list with the read marks applied, and acts without them", () => {
    // A wait the human has marked as read is not a reason to come and
    // look -- but it is still a live session, and reading the masked map
    // in an ACTION is how a silenced badge would come to change what a
    // write does.
    expect(source(VIEW)).toContain("state: $attentionState");
    const actions = source("decisionsActions.ts");
    expect(actions).toContain("get(layoutState)");
    // The import and not the word: the module's own note explains WHY it
    // reads the unmasked map, and a text search for the name would match
    // the explanation.
    expect(actions).toMatch(/import \{ layoutState \} from "\$lib\/core\/layoutState"/);
    expect(actions).not.toMatch(/import \{[^}]*attentionState/);
  });

  it("mounts ReviewAgentPane as-is rather than growing a second agent panel", () => {
    const text = source(VIEW);
    expect(text).toContain("<ReviewAgentPane");
    expect(text).toContain("import ReviewAgentPane from");
    // The pane reads these two bands off its host, so a pane mounted
    // outside a `.review` has to be given them or it draws its head at
    // whatever the browser makes of an unset variable.
    expect(text).toContain("--review-head-height");
    expect(text).toContain("--review-strip-height");
  });

  it("offers a rail gate both honest answers, through orchestrationState's own actions", () => {
    const text = source(VIEW);
    expect(text).toContain("gate(skipGate)");
    expect(text).toContain("gate(markGateDone)");
    const actions = source("decisionsActions.ts");
    expect(actions).toContain("skipStep(workspaceId, stepId)");
    expect(actions).toContain("markStepDone(workspaceId, stepId)");
  });

  it("sends an unreviewed card to the card's own review rather than composing a second prompt", () => {
    // CardDetailModal composes the exact prompt a launch would send; a
    // sheet built here could drift from it, and a sheet that showed a
    // different prompt from the one that will be sent is worse than no
    // sheet at all.
    const text = source(VIEW);
    expect(text).toContain("function openCardReview()");
    expect(text).toContain('setDecisionsPrefs(workspaceId, { pane: "plan" })');
  });

  it("keys its item rows on the line index, which cannot collide", () => {
    // Two identical `Decision:` lines on one card are legal -- only a
    // re-filed TEST is de-duplicated -- and a duplicate key in a keyed
    // each throws.
    expect(source(VIEW)).toContain("{#each subject.items as item (item.lineIndex)}");
  });

  it("clears its error and notice by subject id, never by object identity", () => {
    // A `$state` proxy is never identical to the value it wraps, and a
    // subject is rebuilt on every store emission -- so `!==` on the
    // object would clear the lines on every tick.
    const text = source(VIEW);
    expect(text).toContain("let messagesFor = $state<string | null>(null);");
    expect(text).toContain("if (messagesFor === id) return;");
  });

  it("fetches the board, its refresh and the orchestration the way Review does", () => {
    const text = source(VIEW);
    expect(text).toContain("fetchBoard(workspaceId)");
    expect(text).toContain("refreshBoard(workspaceId)");
    expect(text).toContain("fetchOrchestration(workspaceId)");
  });

  it("wraps its own store write in untrack, so the effect cannot re-enter", () => {
    expect(source(VIEW)).toContain("untrack(() => setDecisionsPrefs(workspaceId, { selected: id }))");
  });
});

describe("the answer controls", () => {
  it("build every payload through decisions.ts", () => {
    const text = source(ROW);
    for (const fn of ["answerOutcome(", "passOutcome()", "failOutcome(", "failAndCloseOutcome("]) {
      expect(text).toContain(fn);
    }
    expect(text).not.toContain('kind: "answer"');
    expect(text).not.toContain('kind: "failAndClose"');
  });

  it("refuses an empty answer and an unexplained failure before sending one", () => {
    const text = source(ROW);
    expect(text).toContain("answerRefusal(picked, note)");
    expect(text).toContain("failRefusal(note)");
  });

  it("guards the write on the item's raw line, not its display text", () => {
    // The daemon matches `expected_text` exactly as `SetChecklistItem`
    // does, so a card an agent rewrote under the tab is refused rather
    // than half-answered at a line that has moved.
    const actions = source("decisionsActions.ts");
    expect(actions).toContain("backend.resolveHumanItem(cardPath, item.lineText, outcome)");
  });

  it("asks before closing a test for good, through the app's own prompt", () => {
    // No native dialogs: @tauri-apps/plugin-dialog is narrowed to
    // `dialog:allow-open`, so `confirm` fails at the permission layer.
    const actions = source("decisionsActions.ts");
    expect(actions).toContain("askConfirm(failAndCloseConfirm(item))");
    expect(actions).not.toContain("@tauri-apps/plugin-dialog");
    expect(source(ROW)).not.toContain("@tauri-apps/plugin-dialog");
  });

  it("keeps the human's words on a refused write and on a dismissed prompt", () => {
    // Ordering is not enough: `onAnswer` resolves either way, so a row
    // that cleared its buffers after awaiting it would wipe what the
    // human typed exactly when they need it back. It has to clear on the
    // ANSWER -- and a cancelled "Fail and close" is not derivable from
    // the error/notice pair, which is why `wrote` is its own field.
    const text = source(ROW);
    expect(text).toContain("wrote = await onAnswer(item, outcome);");
    expect(text).toContain("if (!wrote) return;");
    const actions = source("decisionsActions.ts");
    expect(actions).toContain("wrote: boolean;");
    expect(actions).toContain("return { wrote: false, error: null, notice: null };");
  });

  it("draws hover text through the shared action, never its own bubble", () => {
    // tooltipSurfaces.test.ts enforces this over every component; named
    // here because this row's refusals are ONLY visible as hover text.
    const text = source(ROW);
    expect(text).toContain("use:tooltip");
    expect(text).toContain('import { tooltip } from "$lib/core/tooltip"');
  });
});

describe("telling the agent", () => {
  it("queues one message, and follows queuedInput.ts's refusals", () => {
    const actions = source("decisionsActions.ts");
    expect(actions).toContain("queueFollowUp(sessionId, target,");
    expect(actions).toContain("queueBlockedReason(target)");
    expect(actions).toContain("notifyMessage(cardPath, item, outcome)");
  });

  it("sends nothing unless the card's session is live", () => {
    // The parent plan's rule: live and not interrupted, otherwise the
    // answer waits on the card for the next agent to read.
    const actions = source("decisionsActions.ts");
    expect(actions).toContain('cardSessionState(state, { sessionId }) !== "live"');
    expect(actions).toContain("notifySkipped(SESSION_GONE_REASON)");
    expect(actions).toContain("notifySkipped(NO_SESSION_REASON)");
  });

  it("reports a silent success as a notice rather than as an error", () => {
    // Collapsing the two would draw "the answer landed and nobody was
    // told" in the colour of a failed write.
    const actions = source("decisionsActions.ts");
    expect(actions).toContain("error: string | null");
    expect(actions).toContain("notice: string | null");
    const text = source(VIEW);
    expect(text).toContain("error = result.error;");
    expect(text).toContain("notice = result.notice;");
  });
});
