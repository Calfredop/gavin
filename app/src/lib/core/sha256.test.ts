import { describe, expect, it } from "vitest";
import { sha256Hex } from "$lib/core/sha256";

/// Published vectors, not self-consistency: a hand-written digest that
/// agrees with itself proves nothing, and this one is load-bearing for
/// the workspace-trust gate.
describe("sha256Hex", () => {
  it("matches the NIST vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
    expect(sha256Hex("a".repeat(1000000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
  });

  /// 55, 56 and 64 bytes: where the padding block boundary is decided,
  /// and the only place an off-by-one in the length arithmetic shows.
  it("pads correctly around the block boundary", () => {
    expect(sha256Hex("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
    );
    expect(sha256Hex("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
    );
    expect(sha256Hex("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
    );
  });

  /// The hashed keys are shell lines and paths, which carry any byte a
  /// filesystem does. A digest taken over UTF-16 code units instead of
  /// UTF-8 bytes would still be stable here but would not be SHA-256 of
  /// the file's contents, and nothing downstream would ever say so.
  it("hashes UTF-8 bytes, not code units", () => {
    expect(sha256Hex("ä")).toBe(
      "33e6d73fee82904c8d7afb78de1154d1e8dc2a0edb08120e63df5b9385c2d9cc"
    );
    expect(sha256Hex("→")).toBe(
      "161660030aa6c9e32470cc1c023dab32dc748d80b0e61882b368cb775d12638e"
    );
  });
});
