import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/core/dialog", () => ({
  askConfirm: vi.fn(),
  askConfirmChecked: vi.fn(),
}));
vi.mock("$lib/core/backend", () => ({
  setPlanFrontmatterField: vi.fn(),
}));
vi.mock("$lib/core/gavinState", () => ({
  patchPlanField: vi.fn(),
  patchPlanPath: vi.fn(),
}));

import { askConfirm, askConfirmChecked } from "$lib/core/dialog";
import * as backend from "$lib/core/backend";
import { patchPlanField, patchPlanPath } from "$lib/core/gavinState";
import {
  breakOutChildren,
  completionCascadeFor,
  completionPrompt,
  guardCompletion,
  subjectFromCard,
  type CompletionSubject,
} from "$lib/cards/cardCompletion";
import type { CardView } from "$lib/core/planBoard";
import type { Column } from "$lib/board/kanban";

const COLUMNS: Column[] = [
  { id: "c1", name: "To Do", position: 0 },
  { id: "c2", name: "In Progress", position: 1 },
  { id: "c3", name: "Done", position: 2 },
];

function subject(extra: Partial<CompletionSubject> = {}): CompletionSubject {
  return {
    title: "File explorer",
    kind: "plan",
    status: "In Progress",
    children: [
      { path: "/ws/.gavin-root/plans/lens.md", title: "Tree lens" },
      { path: "/ws/.gavin-root/plans/chip.md", title: "Changes chip" },
    ],
    ...extra,
  };
}

describe("completionCascadeFor", () => {
  it("asks when a plan with nested children is filed into the done column", () => {
    const cascade = completionCascadeFor(subject(), "Done", COLUMNS);
    expect(cascade?.children).toHaveLength(2);
    expect(cascade?.targetColumn).toBe("Done");
    expect(cascade?.breakOutColumn).toBe("To Do");
    expect(cascade?.filesUnderDone).toBe(true);
  });

  it("says nothing for a plan carrying no nested children", () => {
    expect(completionCascadeFor(subject({ children: [] }), "Done", COLUMNS)).toBeNull();
  });

  it("says nothing for a card that is not a plan", () => {
    expect(completionCascadeFor(subject({ kind: "task" }), "Done", COLUMNS)).toBeNull();
  });

  it("says nothing about a move that is not into the terminal column", () => {
    expect(completionCascadeFor(subject(), "In Progress", COLUMNS)).toBeNull();
  });

  it("says nothing when the card is already in the done column", () => {
    // Re-ordering a card inside Done writes its status again; the
    // children went with it the first time and there is nothing new to
    // learn.
    expect(completionCascadeFor(subject({ status: "done" }), "Done", COLUMNS)).toBeNull();
  });

  it("matches the done column by slug, not by exact spelling", () => {
    expect(completionCascadeFor(subject(), " DONE ", COLUMNS)).not.toBeNull();
  });

  // The terminal column is the board's highest position, but `plans/done/`
  // is a slug rule daemon-side: a board that finishes work in "Shipped"
  // still deserves the warning, without a line promising a folder move
  // that will not happen.
  it("warns for a terminal column that is not called Done, without the folder line", () => {
    const shipped: Column[] = [
      { id: "c1", name: "Backlog", position: 0 },
      { id: "c2", name: "Shipped", position: 5 },
    ];
    const cascade = completionCascadeFor(subject(), "Shipped", shipped);
    expect(cascade?.filesUnderDone).toBe(false);
    expect(cascade?.breakOutColumn).toBe("Backlog");
    expect(completionPrompt(cascade!).lines).not.toContain("Their files move into plans/done/ too.");
  });

  it("offers no break-out column when the board's only column is the done one", () => {
    const only: Column[] = [{ id: "c1", name: "Done", position: 0 }];
    const cascade = completionCascadeFor(subject(), "Done", only);
    expect(cascade).not.toBeNull();
    expect(cascade?.breakOutColumn).toBeNull();
    expect(completionPrompt(cascade!).check).toBeUndefined();
  });

  it("says nothing on a board with no columns at all", () => {
    expect(completionCascadeFor(subject(), "Done", [])).toBeNull();
  });
});

describe("completionPrompt", () => {
  it("names every child and the column, and offers the escape", () => {
    const prompt = completionPrompt(completionCascadeFor(subject(), "Done", COLUMNS)!);
    expect(prompt.title).toBe("Move “File explorer” to Done with its 2 nested tasks?");
    expect(prompt.lines).toContain("“Tree lens”");
    expect(prompt.lines).toContain("“Changes chip”");
    expect(prompt.lines).toContain("Their files move into plans/done/ too.");
    expect(prompt.confirmLabel).toBe("Move to Done");
    expect(prompt.check?.label).toBe("Keep them on the board — move them to To Do instead");
    // The box left alone has to mean what the app always did.
    expect(prompt.check?.default).toBeFalsy();
    // Nothing is destroyed here, so Enter must not land on Cancel.
    expect(prompt.danger).toBeFalsy();
  });

  it("reads singular for one child", () => {
    const one = subject({ children: [{ path: "/p/lens.md", title: "Tree lens" }] });
    const prompt = completionPrompt(completionCascadeFor(one, "Done", COLUMNS)!);
    expect(prompt.title).toBe("Move “File explorer” to Done with its 1 nested task?");
    expect(prompt.lines).toContain("Its file moves into plans/done/ too.");
    expect(prompt.check?.label).toBe("Keep it on the board — move it to To Do instead");
  });
});

describe("subjectFromCard", () => {
  it("reads the children off the card the board already drew", () => {
    const child = { id: "/p/lens.md", title: "Tree lens" } as CardView;
    const card = {
      title: "File explorer",
      kind: "plan",
      status: "In Progress",
      nestedChildren: [child],
    } as CardView;
    expect(subjectFromCard(card)).toEqual({
      title: "File explorer",
      kind: "plan",
      status: "In Progress",
      children: [{ path: "/p/lens.md", title: "Tree lens" }],
    });
  });
});

describe("guardCompletion", () => {
  beforeEach(() => {
    vi.mocked(askConfirm).mockReset();
    vi.mocked(askConfirmChecked).mockReset();
    vi.mocked(backend.setPlanFrontmatterField).mockReset();
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (path: string) => path);
    vi.mocked(patchPlanField).mockReset();
    vi.mocked(patchPlanPath).mockReset();
  });

  it("asks nothing, and writes nothing, when there is no cascade", async () => {
    const decision = await guardCompletion("ws", subject(), "In Progress", COLUMNS);
    expect(decision).toEqual({ proceed: true, error: null });
    expect(askConfirmChecked).not.toHaveBeenCalled();
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("lets the children travel when the box is left alone", async () => {
    vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: true, checked: false });
    const decision = await guardCompletion("ws", subject(), "Done", COLUMNS);
    expect(decision.proceed).toBe(true);
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("breaks the children out into the first column when the box is ticked", async () => {
    vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: true, checked: true });
    const decision = await guardCompletion("ws", subject(), "Done", COLUMNS);
    expect(decision).toEqual({ proceed: true, error: null });
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
      ["/ws/.gavin-root/plans/lens.md", "status", "To Do"],
      ["/ws/.gavin-root/plans/chip.md", "status", "To Do"],
    ]);
    expect(patchPlanField).toHaveBeenCalledWith("ws", "/ws/.gavin-root/plans/lens.md", "status", "To Do");
  });

  it("does not file the parent when the human cancels", async () => {
    vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: false, checked: false });
    const decision = await guardCompletion("ws", subject(), "Done", COLUMNS);
    // Cancelling is not a failure: nothing happened and nothing to say.
    expect(decision).toEqual({ proceed: false, error: null });
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  // Stopping matters more here than anywhere else: a half-done rescue
  // followed by the parent's own write would sweep exactly the children
  // the human asked to keep.
  it("stops before the parent is filed when a break-out write fails", async () => {
    vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: true, checked: true });
    vi.mocked(backend.setPlanFrontmatterField).mockRejectedValueOnce(new Error("read-only"));
    const decision = await guardCompletion("ws", subject(), "Done", COLUMNS);
    expect(decision.proceed).toBe(false);
    expect(decision.error).toBe("Couldn't move lens.md to To Do: read-only");
  });

  it("falls back to a plain confirm when there is nowhere to break out to", async () => {
    vi.mocked(askConfirm).mockResolvedValue(true);
    const only: Column[] = [{ id: "c1", name: "Done", position: 0 }];
    const decision = await guardCompletion("ws", subject(), "Done", only);
    expect(decision.proceed).toBe(true);
    expect(askConfirmChecked).not.toHaveBeenCalled();
    expect(askConfirm).toHaveBeenCalled();
  });
});

describe("breakOutChildren", () => {
  beforeEach(() => {
    vi.mocked(backend.setPlanFrontmatterField).mockReset();
    vi.mocked(patchPlanPath).mockReset();
  });

  it("re-points the tree when the write moved the file", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue("/ws/plans/lens.md");
    const decision = await breakOutChildren("ws", [{ path: "/ws/plans/done/lens.md", title: "L" }], "To Do");
    expect(decision.proceed).toBe(true);
    expect(patchPlanPath).toHaveBeenCalledWith("ws", "/ws/plans/done/lens.md", "/ws/plans/lens.md");
  });
});
