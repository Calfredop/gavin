// `crypto.randomUUID`, wherever the bundle runs.
//
// The desktop's Git actions name every op with it (`gitState.ts`: a
// commit, a push, a checkout, a merge), and the host ties the op's
// progress and its Cancel to that id. A browser offers it only in a
// secure context. The Android shell serves the bundle over https, which
// is one; the iOS shell serves it at its own scheme (`gavin-bundle://`),
// which WebKit need not count as one. Without this, every Git action on
// such a page would throw before it sent anything -- a button that does
// nothing and says nothing.
//
// An op id has to be unique, not secret, and `getRandomValues` -- which
// every context has -- is plenty for that.

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
  randomUUID?: () => string;
}

/// A version 4 UUID from `getRandomValues`, in the shape
/// `crypto.randomUUID` gives.
export function uuidFrom(crypto: Pick<CryptoLike, "getRandomValues">): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/// Gives `scope.crypto` a `randomUUID` where it has none. Leaves a real
/// one alone.
export function ensureRandomUUID(scope: object = globalThis): void {
  const crypto = (scope as { crypto?: CryptoLike }).crypto;
  if (!crypto || typeof crypto.randomUUID === "function") return;
  Object.defineProperty(crypto, "randomUUID", {
    value: () => uuidFrom(crypto),
    configurable: true,
    writable: true,
  });
}
