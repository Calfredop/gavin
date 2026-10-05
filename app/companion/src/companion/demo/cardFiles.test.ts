// The demo's card files, read and written the way the daemon reads and
// writes a Workstation's (`crates/daemon/src/gavin.rs`).
import { describe, expect, it } from "vitest";
import {
  humanItems,
  newCardText,
  readCard,
  withChecklistItem,
  withField,
  withHumanOutcome,
} from "$companion/demo/cardFiles";
import { DEMO, sampleState } from "$companion/demo/sampleData";

const CARD = [
  "---",
  "kind: task",
  "title: Pick one",
  "status: In Progress",
  "---",
  "Say which.",
  "",
  "- [x] Read both",
  "- [ ] Decision: Which store?",
  "  Options: A) Redis B) Postgres",
  "- [ ] Human test: It survives a deploy",
  "",
].join("\n");

function plan(fileName: string) {
  const state = sampleState();
  return Object.values(state.trees)
    .flatMap((tree) => tree.contexts.flatMap((ctx) => ctx.plans))
    .find((p) => p.fileName === fileName)!;
}

describe("a card file, read", () => {
  it("is its frontmatter, its checklist counted, and its human items", () => {
    const info = readCard("/r/.gavin-root/plans/pick.md", CARD);
    expect(info).toMatchObject({
      fileName: "pick.md",
      title: "Pick one",
      kind: "task",
      status: "In Progress",
      checklistDone: 1,
      checklistTotal: 3,
    });
    expect(info.humanItems).toMatchObject([
      { kind: "decision", text: "Which store?", options: ["Redis", "Postgres"], state: "open", lineIndex: 8 },
      { kind: "test", text: "It survives a deploy", options: [], state: "open", lineIndex: 10 },
    ]);
  });

  it("reads an item's state off the last outcome written under it", () => {
    const states = (tail: string) => humanItems(`---\ntitle: T\n---\n- [ ] Human test: x\n${tail}`)[0].state;
    expect(states("  Result (2026-09-30): passed\n")).toBe("passed");
    expect(states("  Result (2026-09-30): failed — no\n")).toBe("failed");
    expect(states("  Result (2026-09-29): failed — no\n  Ready for re-test (2026-09-30)\n")).toBe("open");
    expect(states("  Result (2026-09-30): maybe\n")).toBe("open");
    expect(humanItems("---\ntitle: T\n---\n- [x] Decision: y\n  Answer (2026-09-30): yes\n")[0].state).toBe(
      "answered"
    );
  });
});

describe("a card file, written", () => {
  it("sets a field in place, adds one it lacks, and removes one set to nothing", () => {
    expect(withField(CARD, "status", "Review")).toContain("\nstatus: Review\n");
    expect(withField(CARD, "priority", "high").split("\n")[1]).toBe("priority: high");
    expect(withField(CARD, "status", "")).not.toContain("status:");
  });

  it("ticks a line only while it reads what the caller saw", () => {
    expect(withChecklistItem(CARD, 7, "Read both", false)).toContain("- [ ] Read both");
    expect(() => withChecklistItem(CARD, 7, "Read neither", false)).toThrow(/changed on disk/);
  });

  it("answers a decision under it, and ticks it", () => {
    const next = withHumanOutcome(CARD, "Decision: Which store?", { kind: "answer", text: "Redis" }, "2026-09-30");
    expect(next).toContain("- [x] Decision: Which store?\n  Options: A) Redis B) Postgres\n  Answer (2026-09-30): Redis\n");
  });

  it("leaves a failed test owed, and closes it only when told to", () => {
    const failed = withHumanOutcome(CARD, "Human test: It survives a deploy", { kind: "fail", note: "it\nhung" }, "2026-09-30");
    expect(failed).toContain("- [ ] Human test: It survives a deploy\n  Result (2026-09-30): failed — it hung");
    const closed = withHumanOutcome(CARD, "Human test: It survives a deploy", { kind: "failAndClose", note: "" }, "2026-09-30");
    expect(closed).toContain("- [x] Human test: It survives a deploy\n  Result (2026-09-30): failed\n");
    const passed = withHumanOutcome(CARD, "Human test: It survives a deploy", { kind: "pass" }, "2026-09-30");
    expect(humanItems(passed)[1]).toMatchObject({ done: true, state: "passed" });
  });

  it("refuses an item that is no longer on the card", () => {
    expect(() => withHumanOutcome(CARD, "Decision: Gone?", { kind: "pass" }, "2026-09-30")).toThrow(/changed on disk/);
  });

  it("lays a new card out as create_plan does: a plan names no kind, an empty body is its title", () => {
    expect(newCardText({ title: "Ship it", kind: "plan", status: "To Do" })).toBe(
      "---\ntitle: Ship it\nstatus: To Do\n---\n# Ship it\n"
    );
    expect(newCardText({ title: "Child", kind: "task", status: null, parent: "p.md", body: "Do it." })).toBe(
      "---\nkind: task\ntitle: Child\nparent: p.md\n---\nDo it.\n"
    );
  });
});

describe("the demo's cards", () => {
  it("are files, and the tree is what a scan of them reads", () => {
    const state = sampleState();
    for (const tree of Object.values(state.trees)) {
      for (const card of tree.contexts.flatMap((ctx) => ctx.plans)) {
        expect(readCard(card.path, state.files[card.path])).toEqual(card);
      }
    }
  });

  it("carry the cases a board and a card draw", () => {
    expect(plan("token-refresh.md")).toMatchObject({ kind: "plan", checklistDone: 3, checklistTotal: 7 });
    expect(plan("rotate-on-use.md")).toMatchObject({ kind: "task", parent: "token-refresh.md", status: null });
    expect(plan("session-store.md").humanItems).toMatchObject([
      { kind: "decision", options: ["Redis", "Postgres"], state: "open" },
    ]);
    expect(plan("invoice-pdf.md").humanItems).toMatchObject([{ kind: "test", state: "open" }]);
    expect(plan("audit-log-export.md").path).toContain("/plans/done/");
    expect(plan("oauth-upgrade.md").status).toBe("Blocked");
  });

  it("include each project's PRD and what a card points an agent at", () => {
    const { files } = sampleState();
    expect(files[`${DEMO.atlasRoot}/.gavin-root/PRD.md`]).toMatch(/^# atlas-api/);
    expect(files[`${DEMO.notesRoot}/.gavin-root/PRD.md`]).toMatch(/^# field-notes/);
    expect(files[`${DEMO.atlasRoot}/docs/rate-limits.md`]).toBeDefined();
  });
});
