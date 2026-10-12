import { describe, expect, it } from "vitest";
import {
  effectiveListForPrimary,
  listForPrimary,
  sanitizeList,
  withListForPrimary,
  workspaceOwnsList,
} from "./promptParams";

describe("sanitizeList", () => {
  it("trims, drops blanks, keeps order and duplicates", () => {
    expect(sanitizeList(["  a ", "", "   ", "b", "a"])).toEqual(["a", "b", "a"]);
    expect(sanitizeList(null)).toEqual([]);
    expect(sanitizeList(undefined)).toEqual([]);
  });
});

describe("listForPrimary", () => {
  const map = { codex: ["--x"], empty: [] as string[] };

  it("answers the key's list, [] for a missing key or a blank id", () => {
    expect(listForPrimary(map, "codex")).toEqual(["--x"]);
    expect(listForPrimary(map, "gemini")).toEqual([]);
    expect(listForPrimary(map, " ")).toEqual([]);
    expect(listForPrimary(null, "codex")).toEqual([]);
  });
});

describe("effectiveListForPrimary", () => {
  const app = { codex: ["--app"], "claude-code": ["--app-claude"] };

  it("inherits the app-wide list when the workspace has no key for the agent", () => {
    expect(effectiveListForPrimary({}, app, "codex")).toEqual(["--app"]);
    expect(effectiveListForPrimary(undefined, app, "codex")).toEqual(["--app"]);
    expect(effectiveListForPrimary({ gemini: ["--g"] }, app, "codex")).toEqual(["--app"]);
  });

  it("lets a present workspace key override whole", () => {
    expect(effectiveListForPrimary({ codex: ["--own"] }, app, "codex")).toEqual(["--own"]);
  });

  /// Present-and-empty is a real answer: "nothing extra for this agent
  /// here", not "inherit". The fallback chains' rule, for the same reason.
  it("reads an own empty list as 'none', not as inherit", () => {
    expect(effectiveListForPrimary({ codex: [] }, app, "codex")).toEqual([]);
  });

  it("is empty for a blank primary, and when neither side has the agent", () => {
    expect(effectiveListForPrimary({}, app, "")).toEqual([]);
    expect(effectiveListForPrimary({}, app, "gemini")).toEqual([]);
  });
});

describe("workspaceOwnsList", () => {
  it("is true only for a present key, even an empty one", () => {
    expect(workspaceOwnsList({ codex: [] }, "codex")).toBe(true);
    expect(workspaceOwnsList({ codex: ["x"] }, "codex")).toBe(true);
    expect(workspaceOwnsList({ codex: ["x"] }, "gemini")).toBe(false);
    expect(workspaceOwnsList(undefined, "codex")).toBe(false);
    expect(workspaceOwnsList({}, "")).toBe(false);
  });
});

describe("withListForPrimary", () => {
  const map = { codex: ["--a"], gemini: ["--g"] };

  it("sets one key without touching the others or mutating the input", () => {
    const next = withListForPrimary(map, "codex", [" --b ", ""]);
    expect(next).toEqual({ codex: ["--b"], gemini: ["--g"] });
    expect(map.codex).toEqual(["--a"]);
  });

  it("removes the key for null so the agent inherits again, and keeps [] as an explicit none", () => {
    expect(withListForPrimary(map, "codex", null)).toEqual({ gemini: ["--g"] });
    expect(withListForPrimary(map, "codex", [])).toEqual({ codex: [], gemini: ["--g"] });
  });

  it("ignores a blank id", () => {
    expect(withListForPrimary(map, "  ", ["x"])).toEqual(map);
    expect(withListForPrimary(null, "codex", ["x"])).toEqual({ codex: ["x"] });
  });
});
