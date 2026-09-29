import { describe, it, expect } from "vitest";
import { osc52Text } from "$lib/terminal/osc52";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("osc52Text", () => {
  it("decodes the clipboard selection's base64 text", () => {
    expect(osc52Text(`c;${b64("hello")}`)).toBe("hello");
  });

  it("decodes UTF-8, not Latin-1", () => {
    expect(osc52Text(`c;${b64("héllo ✓ 日本")}`)).toBe("héllo ✓ 日本");
  });

  it("keeps the text's line breaks", () => {
    expect(osc52Text(`c;${b64("one\ntwo\n")}`)).toBe("one\ntwo\n");
  });

  it("takes any selection name, or none, as the clipboard", () => {
    expect(osc52Text(`;${b64("a")}`)).toBe("a");
    expect(osc52Text(`p;${b64("b")}`)).toBe("b");
    expect(osc52Text(`s0;${b64("c")}`)).toBe("c");
  });

  it("never answers a query for what is on the clipboard", () => {
    expect(osc52Text("c;?")).toBeNull();
  });

  it("ignores a request to clear the clipboard", () => {
    expect(osc52Text("c;")).toBeNull();
  });

  it("ignores a payload with no selection part", () => {
    expect(osc52Text(b64("hello"))).toBeNull();
  });

  it("ignores text that is not base64", () => {
    expect(osc52Text("c;not base64!")).toBeNull();
  });
});
