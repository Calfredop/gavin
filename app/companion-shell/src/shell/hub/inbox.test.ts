// The combined inbox: every ready Workstation's items, labelled, and
// nothing from a Workstation that is not ready.
import { describe, expect, it } from "vitest";
import type { AttentionItem } from "$shell/connection/attention";
import { combinedInbox, kindLabel } from "$shell/hub/inbox";
import type { LiveState } from "$shell/hub/live";

const item = (id: string, overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  workspace: "ws-1",
  kind: "waiting",
  text: `${id} needs you`,
  target: { kind: "session", id: `s-${id}` },
  ...overrides,
});

const STUDIO = { id: "ws-aaaa", name: "Studio" };
const LAPTOP = { id: "ws-bbbb", name: "Laptop" };

describe("the combined inbox", () => {
  it("gathers every ready Workstation's items, each labelled with its Workstation", () => {
    const live: Record<string, LiveState> = {
      [STUDIO.id]: { state: "ready", items: [item("a"), item("b", { kind: "human-test", target: { kind: "card", path: "plans/x.md" } })] },
      [LAPTOP.id]: { state: "ready", items: [item("a", { kind: "rail-stopped" })] },
    };
    expect(combinedInbox([STUDIO, LAPTOP], live)).toEqual([
      {
        key: "ws-aaaa/a",
        workstationId: "ws-aaaa",
        workstationName: "Studio",
        workspace: "ws-1",
        kind: "waiting",
        text: "a needs you",
        target: { kind: "session", id: "s-a" },
      },
      {
        key: "ws-aaaa/b",
        workstationId: "ws-aaaa",
        workstationName: "Studio",
        workspace: "ws-1",
        kind: "human-test",
        text: "b needs you",
        target: { kind: "card", path: "plans/x.md" },
      },
      {
        key: "ws-bbbb/a",
        workstationId: "ws-bbbb",
        workstationName: "Laptop",
        workspace: "ws-1",
        kind: "rail-stopped",
        text: "a needs you",
        target: { kind: "session", id: "s-a" },
      },
    ]);
  });

  it("follows the hub's order and the Workstation's current name", () => {
    const live: Record<string, LiveState> = {
      [STUDIO.id]: { state: "ready", items: [item("s")] },
      [LAPTOP.id]: { state: "ready", items: [item("l")] },
    };
    const rows = combinedInbox([{ ...LAPTOP, name: "Travel" }, STUDIO], live);
    expect(rows.map((r) => [r.workstationName, r.text])).toEqual([
      ["Travel", "l needs you"],
      ["Studio", "s needs you"],
    ]);
  });

  it("adds nothing from a Workstation that is unreachable, asleep, locked, connecting or has no desktop app running", () => {
    const notReady: LiveState[] = [
      { state: "desktop-app-not-running" },
      { state: "unreachable", problem: "Could not reach its Relay." },
      { state: "asleep" },
      { state: "locked" },
      { state: "connecting" },
      { state: "refused", problem: "Revoked." },
      { state: "failed", problem: "No keys." },
    ];
    for (const state of notReady) {
      const rows = combinedInbox([STUDIO, LAPTOP], {
        [STUDIO.id]: state,
        [LAPTOP.id]: { state: "ready", items: [item("l")] },
      });
      expect(rows.map((r) => r.key), state.state).toEqual(["ws-bbbb/l"]);
    }
  });

  it("adds nothing for a Workstation it has no state for", () => {
    expect(combinedInbox([STUDIO], {})).toEqual([]);
  });

  it("shows an item its desk listed twice once", () => {
    const rows = combinedInbox([STUDIO], { [STUDIO.id]: { state: "ready", items: [item("a"), item("a")] } });
    expect(rows).toHaveLength(1);
  });

  it("names each kind for the row", () => {
    expect(kindLabel("waiting")).toBe("Agent waiting");
    expect(kindLabel("human-test")).toBe("Human test");
    expect(kindLabel("rail-stopped")).toBe("Rail stopped");
    expect(kindLabel("other")).toBe("Needs you");
  });
});
