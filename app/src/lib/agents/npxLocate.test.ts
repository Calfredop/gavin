import { describe, expect, it } from "vitest";
import {
  NPX_NOT_FOUND,
  isNpxNotFound,
  npxPathProblem,
  playwrightLacksLocalNpx,
  whereCommand,
} from "./npxLocate";

const NPX_RS = Object.values(
  import.meta.glob("../../../src-tauri/src/npx.rs", { query: "?raw", import: "default", eager: true })
)[0] as string;

describe("npxLocate", () => {
  it("recognises the host's not-found message and nothing else", () => {
    expect(isNpxNotFound(`${NPX_NOT_FOUND} — gavin looked on PATH, …`)).toBe(true);
    expect(isNpxNotFound("Error: npx was not found — gavin looked")).toBe(true);
    expect(isNpxNotFound("claude was not found on PATH")).toBe(false);
    expect(isNpxNotFound("failed to run npx: permission denied")).toBe(false);
    expect(isNpxNotFound(null)).toBe(false);
  });

  it("keeps the prefix in step with the host", () => {
    expect(NPX_RS).toContain(`pub const NOT_FOUND: &str = "${NPX_NOT_FOUND}";`);
  });

  it("asks only when THIS machine's npx check failed", () => {
    const missing = [{ id: "npx", ok: false }, { id: "browser", ok: false }];
    expect(playwrightLacksLocalNpx(missing, false)).toBe(true);
    expect(playwrightLacksLocalNpx(missing, true)).toBe(false);
    expect(playwrightLacksLocalNpx([{ id: "npx", ok: null }], false)).toBe(false);
    expect(playwrightLacksLocalNpx([{ id: "npx", ok: true }], false)).toBe(false);
  });

  it("checks a typed path before it crosses", () => {
    expect(npxPathProblem("")).toMatch(/Paste/);
    expect(npxPathProblem("npx")).toMatch(/full path/);
    expect(npxPathProblem("/usr/local/bin/node")).toMatch(/end in npx/);
    expect(npxPathProblem("  /Users/ada/.local/share/mise/installs/node/22/bin/npx ")).toBeNull();
    expect(npxPathProblem("~/.volta/bin/npx")).toBeNull();
    expect(npxPathProblem("C:\\Program Files\\nodejs\\npx.cmd")).toBeNull();
  });

  it("names the platform's lookup", () => {
    expect(whereCommand(false)).toBe("command -v npx");
    expect(whereCommand(true)).toBe("where npx");
  });
});
