import { describe, it, expect } from "vitest";
import { buildCreatePlanArgs } from "./cardCompose";

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
