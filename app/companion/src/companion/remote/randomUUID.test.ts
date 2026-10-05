import { describe, expect, it } from "vitest";
import { ensureRandomUUID, uuidFrom } from "$companion/remote/randomUUID";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function insecureCrypto() {
  return { getRandomValues: <T extends ArrayBufferView | null>(a: T): T => globalThis.crypto.getRandomValues(a) };
}

describe("an op id where the page is not a secure context", () => {
  it("is a version 4 UUID, and a new one every time", () => {
    const crypto = insecureCrypto();
    const ids = new Set(Array.from({ length: 50 }, () => uuidFrom(crypto)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it("is given to a crypto that has no randomUUID of its own", () => {
    const scope = { crypto: insecureCrypto() as { randomUUID?: () => string } };
    ensureRandomUUID(scope);
    expect(scope.crypto.randomUUID?.()).toMatch(UUID_V4);
  });

  it("leaves a real one alone, and a page with no crypto at all", () => {
    const real = () => "real";
    const scope = { crypto: { ...insecureCrypto(), randomUUID: real } };
    ensureRandomUUID(scope);
    expect(scope.crypto.randomUUID).toBe(real);
    expect(() => ensureRandomUUID({})).not.toThrow();
  });
});
