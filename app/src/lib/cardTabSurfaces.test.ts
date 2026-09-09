import { describe, it, expect } from "vitest";
import { allSources } from "$lib/sources";

// A card tab is a fourth kind of pane tab, and nothing type-checks the
// rules that make it one. The compiler is happy with a chip that opens a
// pane no renderer draws, with a detail panel that keeps a backdrop it
// no longer floats over, and -- the expensive one -- with a persisted tab
// id that Rust does not list among the non-session ids, which is not a
// blank pane on the next launch but a freshly spawned shell in its place.
//
// Reads sources rather than the rendered DOM, following
// runChangesSurfaces.test.ts: mounting a pane to assert "this handler
// was called" tests the harness.

const SOURCES = allSources();

const RUST = import.meta.glob("../../src-tauri/src/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

function rust(name: string): string {
  const text = RUST[`../../src-tauri/src/${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("the tab bar's two chips", () => {
  const PANE = "Pane.svelte";

  it("offers Show plan, not a jump that leaves the terminal behind", () => {
    const text = source(PANE);
    expect(text).toContain("Show the plan this agent is running");
    // On the ACTIVE tab, not on each one: both chips left the individual
    // tab for the bar's action group, where they sit beside the other
    // controls that act on what the pane is showing. A tab is a label
    // with a close box again.
    expect(text).toContain('openCardInSplit(active, ws.id, link.path, "plan")');
    // The jump did not vanish, it moved onto the plan panel -- so the tab
    // bar must no longer hold it.
    expect(text).not.toContain("openLinkedCard(");
  });

  it("wears a plan glyph rather than the old open-elsewhere arrow", () => {
    const text = source(PANE);
    // One of the bar's IconButtons now, so it carries the same label,
    // tooltip and hit area as Split Right beside it.
    expect(text).toContain("icon={ListChecks}");
    expect(text).not.toContain("SquareArrowOutUpRight");
  });

  it("hangs both chips off a terminal, never off another view pane", () => {
    // Without the guard a card pane would draw a chip offering to open a
    // card pane beside itself.
    const text = source(PANE);
    expect(text).toContain("function isViewTab(tabId: string): boolean");
    expect(text).toContain("return Boolean(boardTab(tabId) || fileTabPath(tabId) || cardTab(tabId));");
    expect(text).toContain("if (isViewTab(sessionId)) return null;");
  });

  it("renders the pane it opens", () => {
    expect(source(PANE)).toContain("<CardTabPane");
  });
});

describe("the plan panel in a pane", () => {
  const CARD_PANE = "CardTabPane.svelte";
  const DETAIL = "CardDetailModal.svelte";
  const MODAL = "Modal.svelte";

  it("is the very same component the hub tabs mount, drawn inline", () => {
    // Two detail panels for one card is how they drift apart.
    const text = source(CARD_PANE);
    expect(text).toContain("<CardDetailModal");
    expect(text).toContain("inline");
  });

  it("carries the jump to the board, which the tab chip used to be", () => {
    expect(source(CARD_PANE)).toContain("onGoToBoard={() => void openLinkedCard(workspaceId, link)}");
    expect(source(DETAIL)).toContain('<button type="button" class="go-to-board"');
  });

  it("offers that jump ONLY where it goes somewhere", () => {
    // The Kanban and Orchestration tabs already ARE where it would go, so
    // the action is absent there rather than a no-op: it is opt-in per
    // host, and only the pane opts in.
    const text = source(DETAIL);
    expect(text).toContain("{#if onGoToBoard}");
    expect(text).toContain("onGoToBoard = null,");
    expect(source("KanbanBoard.svelte")).not.toContain("onGoToBoard");
    expect(source("OrchestrationHubView.svelte")).not.toContain("onGoToBoard");
    expect(source("BoardPane.svelte")).not.toContain("onGoToBoard");
  });

  it("stops being dismissable by Escape or a click outside once inline", () => {
    // A pane the human split off deliberately must not vanish because
    // they pressed Escape in the terminal beside it -- and an inline
    // panel that still pushed onto the modal stack would swallow the
    // Escape meant for a real dialog above it.
    const text = source(MODAL);
    expect(text).toContain("if (inline) return;\n    const mine = pushModal();");
    // The backdrop is a window-drag surface now (it covers every bar
    // the window's own drag lives on), so what an inline panel withholds
    // is the action's callback rather than an early return in a handler.
    expect(text).toContain("const backdropClick = $derived(inline ? null : () => onClose());");
    expect(text).toContain('if (event.key !== "Escape") return;');
  });

  it("navigates within itself without dragging its sibling panes along", () => {
    // The Tasks list repoints THIS pane; a card file that MOVED repoints
    // every pane showing it. Two different writes, deliberately.
    const text = source(CARD_PANE);
    expect(text).toContain("onOpenCard={(next) => void setCardTabPath(tabId, next)}");
    expect(text).toContain("onPathChange={(next) => void retargetCardTabs(path, next)}");
  });
});

describe("a card tab is a tab like the other two", () => {
  it("is persisted, so a restart does not turn it into a shell", () => {
    // resolve_sessions replaces every layout id the daemon has never
    // heard of with a freshly created session. An id in the tree that no
    // tab map claims is exactly that, so the map has to reach Rust.
    expect(source("layoutState.ts")).toContain("backend.setCardTabs(cardTabsById)");
    expect(source("backend.ts")).toContain('invoke("set_card_tabs", { cardTabs })');
    expect(rust("session.rs")).toContain("non_session_tab_ids(&file_tabs, &board_tabs, &card_tabs)");
    expect(rust("session.rs")).toContain("app_handle.manage(CardTabs(Mutex::new(card_tabs)));");
  });

  it("is seeded and repaired from Rust alongside the other two maps", () => {
    const text = source("layoutState.ts");
    expect(text).toContain("backend.getCardTabs().catch(() => null)");
    expect(text).toContain("cardTabsById: { ...(cardTabs ?? {}), ...s.cardTabsById }");
    expect(text).toContain("if (cardTabs) for (const id of cards) cardTabsById[id] ??= cardTabs[id];");
  });

  it("never gates the OTHER two maps on its own command existing", () => {
    // vite serves the frontend live under `tauri dev`, so this module can
    // reach a window whose binary predates `get_card_tabs`. Requiring it
    // would seed nothing at all -- and an id in a layout tree that no map
    // claims is a terminal, so the cost would be a PTY per restored file
    // and board tab.
    const text = source("layoutState.ts");
    expect(text).toContain("if (fileTabs && boardTabs) {");
    expect(text).toContain("if (!fileTabs || !boardTabs) return;");
  });

  it("counts as a view, not as an agent, everywhere that tells them apart", () => {
    expect(source("layout.ts")).toContain(
      "return ids.filter((id) => !fileTabsById[id] && !boardTabsById[id] && !cardTabsById[id]);"
    );
    expect(source("sidebarSummary.ts")).toContain(
      'if (state.cardTabsById[id]) return { id, kind: "card", status: null };'
    );
    expect(source("confirmClose.ts")).toContain("!state.cardTabsById[sessionId]");
  });

  it("closes with the card it was showing when that card is archived", () => {
    // Same rule the card's file tabs already followed: the card leaves
    // the board, so the panes onto it go with it.
    expect(source("archiveClose.ts")).toContain("...Object.entries(state.cardTabsById),");
  });
});
