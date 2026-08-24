import { describe, it, expect } from "vitest";
import { buildCreatePlanArgs, defaultComposeStatus, railToApply } from "./cardCompose";

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
