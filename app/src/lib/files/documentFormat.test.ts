import { describe, it, expect } from "vitest";
import { canFormatDocument, formatDocument } from "$lib/files/documentFormat";

describe("canFormatDocument", () => {
  it("is true only for JSON paths", () => {
    expect(canFormatDocument("/tmp/a.json")).toBe(true);
    expect(canFormatDocument("/tmp/a.JSON")).toBe(true);
    expect(canFormatDocument("/tmp/a.ts")).toBe(false);
    expect(canFormatDocument("/tmp/a.md")).toBe(false);
    expect(canFormatDocument("/tmp/a.rs")).toBe(false);
  });
});

describe("formatDocument", () => {
  it("pretty-prints JSON with 2-space indent", () => {
    const result = formatDocument("/tmp/a.json", '{"a":1,"b":[2,3]}');
    expect(result).toEqual({
      ok: true,
      text: '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}',
    });
  });

  it("keeps a trailing newline when the input had one", () => {
    const result = formatDocument("/tmp/a.json", '{"a":1}\n');
    expect(result).toEqual({ ok: true, text: '{\n  "a": 1\n}\n' });
  });

  it("leaves an empty buffer alone", () => {
    expect(formatDocument("/tmp/a.json", "")).toEqual({ ok: true, text: "" });
    expect(formatDocument("/tmp/a.json", "   \n")).toEqual({ ok: true, text: "   \n" });
  });

  it("refuses invalid JSON without rewriting", () => {
    const result = formatDocument("/tmp/a.json", "{not json");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/^Invalid JSON:/);
  });

  it("refuses a non-JSON path", () => {
    expect(formatDocument("/tmp/a.ts", "const x = 1")).toEqual({
      ok: false,
      reason: "No formatter for this file type.",
    });
  });
});
