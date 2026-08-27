import { describe, it, expect } from "vitest";
import {
  buildCreatePlanArgs,
  composeHint,
  composeKeyAction,
  defaultComposeStatus,
  railToApply,
  COMPOSE_KINDS,
  DEFAULT_COMPOSE_KIND,
} from "./cardCompose";

describe("COMPOSE_KINDS", () => {
  it("opens on task, so ⌘N files runnable work by default", () => {
    expect(DEFAULT_COMPOSE_KIND).toBe("task");
  });

  it("offers the note chip last", () => {
    expect(COMPOSE_KINDS).toEqual(["task", "plan", "note"]);
  });

  it("starts on the kind it offers first", () => {
    expect(COMPOSE_KINDS[0]).toBe(DEFAULT_COMPOSE_KIND);
  });
});

describe("buildCreatePlanArgs", () => {
  it("slugs the title into a file name", () => {
    const r = buildCreatePlanArgs({ kind: "note", title: "Fix the Login Flow!", body: "", status: "To Do" }, []);
    expect(r).toEqual({ fileName: "fix-the-login-flow.md", title: "Fix the Login Flow!", status: "To Do", body: undefined, kind: "note" });
  });

  it("suffixes on collision until free", () => {
    const r = buildCreatePlanArgs(
      { kind: "plan", title: "Demo", body: "b", status: "Done" },
      ["demo.md", "demo-2.md"]
    );
    expect(r).toMatchObject({ fileName: "demo-3.md", body: "b" });
  });

  it("errors on empty or unusable titles", () => {
    expect(buildCreatePlanArgs({ kind: "note", title: "   ", body: "", status: "x" }, [])).toHaveProperty("error");
    expect(buildCreatePlanArgs({ kind: "note", title: "!!!", body: "", status: "x" }, [])).toHaveProperty("error");
  });

  it("passes a task's prompt body through", () => {
    const r = buildCreatePlanArgs({ kind: "task", title: "T", body: "  do the thing  ", status: "To Do" }, []);
    expect(r).toMatchObject({ kind: "task", body: "do the thing" });
  });
});

describe("defaultComposeStatus", () => {
  it("keeps the column that asked", () => {
    expect(defaultComposeStatus(["To Do", "In Progress", "Done"], "In Progress")).toBe("In Progress");
  });

  it("falls back to the leftmost column when nothing asked", () => {
    expect(defaultComposeStatus(["To Do", "Done"], null)).toBe("To Do");
  });

  it("falls back when the asking column is gone (renamed or deleted)", () => {
    expect(defaultComposeStatus(["To Do", "Done"], "Backlog")).toBe("To Do");
  });

  it("has no status to offer on a board with no columns", () => {
    expect(defaultComposeStatus([], "To Do")).toBeNull();
  });
});

describe("railToApply", () => {
  it("places a task or a plan on the picked rail", () => {
    expect(railToApply("task", "r1", ["r1", "r2"])).toBe("r1");
    expect(railToApply("plan", "r2", ["r1", "r2"])).toBe("r2");
  });

  it("never puts a note on a rail", () => {
    expect(railToApply("note", "r1", ["r1"])).toBeNull();
  });

  it("drops a rail deleted since the picker rendered", () => {
    expect(railToApply("task", "r9", ["r1"])).toBeNull();
  });

  it("no pick, no placement", () => {
    expect(railToApply("task", null, ["r1"])).toBeNull();
  });
});

describe("composeKeyAction", () => {
  const press = (over: Partial<Record<string, unknown>> = {}) => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  }) as Parameters<typeof composeKeyAction>[1];

  it("keeps the fast path: bare Enter in the title files the card", () => {
    expect(composeKeyAction("title", press(), true)).toBe("commit");
    expect(composeKeyAction("title", press(), false)).toBe("commit");
  });

  it("leaves a bare Enter in the body to the body", () => {
    // The reported bug is the OTHER half of this: the body had no
    // handler, so the footer still promised "Enter adds" there.
    expect(composeKeyAction("body", press(), true)).toBe("newline");
    expect(composeKeyAction("body", press(), false)).toBe("newline");
  });

  it("commits on the chord from either field", () => {
    expect(composeKeyAction("body", press({ metaKey: true }), true)).toBe("commit");
    expect(composeKeyAction("title", press({ metaKey: true }), true)).toBe("commit");
    expect(composeKeyAction("body", press({ ctrlKey: true }), false)).toBe("commit");
    expect(composeKeyAction("title", press({ ctrlKey: true }), false)).toBe("commit");
  });

  it("wants the platform's own chord, not the other one", () => {
    expect(composeKeyAction("body", press({ ctrlKey: true }), true)).toBeNull();
    expect(composeKeyAction("body", press({ metaKey: true }), false)).toBeNull();
  });

  it("gives the title a newline on shift", () => {
    expect(composeKeyAction("title", press({ shiftKey: true }), true)).toBe("newline");
    expect(composeKeyAction("body", press({ shiftKey: true }), true)).toBe("newline");
  });

  it("does not steal the shifted or alted chord", () => {
    expect(composeKeyAction("title", press({ metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(composeKeyAction("title", press({ altKey: true }), true)).toBeNull();
  });

  it("ignores every key that is not Enter", () => {
    expect(composeKeyAction("title", press({ key: "a" }), true)).toBeNull();
    expect(composeKeyAction("title", press({ key: "Escape" }), true)).toBeNull();
  });

  it("leaves an IME candidate's Enter alone", () => {
    expect(composeKeyAction("title", press({ isComposing: true }), true)).toBeNull();
    expect(composeKeyAction("title", press({ isComposing: true, metaKey: true }), true)).toBeNull();
  });
});

describe("composeHint", () => {
  it("names Enter in the title and the chord in the body", () => {
    expect(composeHint("title", true)).toContain("Enter adds");
    expect(composeHint("body", true)).toContain("\u2318Enter adds");
    expect(composeHint("body", false)).toContain("Ctrl+Enter adds");
  });

  it("never promises a bare Enter files the card from the body", () => {
    expect(composeHint("body", true).startsWith("Enter adds")).toBe(false);
    expect(composeHint("body", false).startsWith("Enter adds")).toBe(false);
  });

  it("always says how to get out", () => {
    for (const field of ["title", "body"] as const)
      for (const mac of [true, false]) expect(composeHint(field, mac)).toContain("Esc closes");
  });
});
