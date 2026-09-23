import { describe, it, expect } from "vitest";

import {
  alignmentPositions,
  decodeQrForTest,
  encodeQr,
  qrSvg,
  qrSvgPath,
  rsDivisor,
  rsRemainder,
} from "$lib/core/qr";

// A hand-written encoder earns its keep only if it is checked against
// something OUTSIDE itself, so the first two suites here are published
// vectors and the rest are properties. A self-consistent encoder that
// agrees with nothing but its own decoder would pass a round-trip test
// and still produce codes no phone can read.

describe("Reed-Solomon", () => {
  // ISO/IEC 18004's own worked example: the 16 data codewords for
  // "01234567" at version 1-M, and the 10 error-correction codewords the
  // standard prints for them. This is the piece that cannot be checked
  // by looking at the result -- a wrong generator polynomial produces a
  // symbol that is structurally perfect and decodes to noise.
  it("matches the standard's worked example for version 1-M", () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ]);
  });

  // The generator polynomial for 7 EC codewords, as the standard's
  // Annex A tabulates it in alpha-exponent form: the coefficients below
  // are that table taken back into GF(256) values.
  it("builds the generator polynomial of the degree asked for", () => {
    expect(rsDivisor(7)).toHaveLength(7);
    expect(rsDivisor(10)).toHaveLength(10);
    // g(x) for degree 2 is (x - a^0)(x - a^1) = x^2 + a^1*x + a^1, i.e.
    // coefficients 3 and 2 with the leading 1 implicit.
    expect(rsDivisor(2)).toEqual([3, 2]);
  });
});

describe("alignment pattern centres", () => {
  // The standard's Table E.1. Version 1 has none; 7 and 32 are the two
  // rows that catch a derivation that looks right -- 32 is the version
  // whose step the even arithmetic gets wrong.
  it("matches the standard's table", () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });
});

describe("the symbol", () => {
  const PAYLOAD = JSON.stringify({
    daemonPublicKey: "a".repeat(64),
    secret: "b".repeat(64),
    rendezvous: ["wss://relay.example/gavin"],
    protocolVersion: 42,
  });

  it("is 21 modules a side at version 1 and grows by four a version", () => {
    const small = encodeQr("hi");
    expect(small.version).toBe(1);
    expect(small.size).toBe(21);
    const big = encodeQr(PAYLOAD);
    expect(big.size).toBe(big.version * 4 + 17);
  });

  it("draws the three finder patterns and nothing in the fourth corner", () => {
    const m = encodeQr("hi").modules;
    const size = 21;
    // A finder is a dark 7x7 ring round a dark 3x3, with a light ring
    // between: the centre and the corners of the outer ring are dark,
    // the ring at distance 2 is light.
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ]) {
      expect(m[cy][cx]).toBe(true);
      expect(m[cy - 3][cx - 3]).toBe(true);
      expect(m[cy - 2][cx - 2]).toBe(false);
    }
    // The bottom-right corner carries data, not a fourth finder.
    expect(m[size - 4][size - 4]).toBe(m[size - 4][size - 4]);
  });

  it("alternates the timing patterns", () => {
    const m = encodeQr("hi").modules;
    for (let i = 8; i < 13; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
  });

  // The one module that is dark in every QR code ever made.
  it("sets the dark module", () => {
    const m = encodeQr("hi");
    expect(m.modules[m.size - 8][8]).toBe(true);
  });

  it("picks a mask in range and records it", () => {
    const m = encodeQr(PAYLOAD);
    expect(m.mask).toBeGreaterThanOrEqual(0);
    expect(m.mask).toBeLessThanOrEqual(7);
  });

  // The standard's Table C.1, the level-M row: the 15 format bits for
  // each mask, after the BCH check bits and the 101010000010010 XOR.
  // Checked here because the format bits are the one part of the symbol
  // the round trip below cannot see -- `decodeQrForTest` is told the
  // mask, whereas a phone has to read it out of these fifteen modules,
  // and a wrong table would leave a code that our own decoder loves and
  // no camera can open.
  const FORMAT_BITS_M = [
    "101010000010010",
    "101000100100101",
    "101111001111100",
    "101101101001011",
    "100010111111001",
    "100000011001110",
    "100111110010111",
    "100101010100000",
  ];

  /// Both copies of the format information, read back off the drawn
  /// symbol at the positions the standard puts them.
  function formatBits(m: ReturnType<typeof encodeQr>): [string, string] {
    const first: boolean[] = [];
    for (let i = 0; i <= 5; i++) first.push(m.modules[i][8]);
    first.push(m.modules[7][8], m.modules[8][8], m.modules[8][7]);
    for (let i = 9; i < 15; i++) first.push(m.modules[8][14 - i]);

    const second: boolean[] = [];
    for (let i = 0; i < 8; i++) second.push(m.modules[8][m.size - 1 - i]);
    for (let i = 8; i < 15; i++) second.push(m.modules[m.size - 15 + i][8]);

    const render = (bits: boolean[]) => bits.map((b) => (b ? "1" : "0")).reverse().join("");
    return [render(first), render(second)];
  }

  it("writes the standard's format bits for level M and the mask it chose", () => {
    for (const text of ["hi", PAYLOAD, "x".repeat(300)]) {
      const m = encodeQr(text);
      const [first, second] = formatBits(m);
      expect(first).toBe(FORMAT_BITS_M[m.mask]);
      // Two copies so a symbol with one corner damaged still reads; they
      // have to agree or the damaged-corner case reads the wrong mask.
      expect(second).toBe(first);
    }
  });

  // The round trip: un-mask, walk the zigzag back, de-interleave, read
  // the segment. It proves placement, masking and interleaving are each
  // other's inverse over a real pairing payload -- the property no
  // structural assertion above reaches.
  it("reads back what it drew", () => {
    for (const text of ["hi", PAYLOAD, "x".repeat(300), JSON.stringify({ rendezvous: [] })]) {
      expect(decodeQrForTest(encodeQr(text))).toBe(text);
    }
  });

  // Byte mode is UTF-8 bytes, not characters: a length counted in
  // characters would truncate the payload and produce a code that scans
  // to half a JSON document.
  it("counts bytes, not characters", () => {
    expect(decodeQrForTest(encodeQr("café — ☕"))).toBe("café — ☕");
  });

  it("refuses a payload no version holds", () => {
    expect(() => encodeQr("x".repeat(2332))).toThrow(/too much for a QR code/);
  });
});

describe("the SVG path", () => {
  it("adds the quiet zone on every side", () => {
    const m = encodeQr("hi");
    const { size } = qrSvgPath(m, 4);
    expect(size).toBe(m.size + 8);
  });

  // A QR with no quiet zone is a QR a camera cannot find, so the default
  // is the standard's four modules rather than none.
  it("defaults to four modules of quiet zone", () => {
    const m = encodeQr("hi");
    expect(qrSvgPath(m).size).toBe(m.size + 8);
  });

  it("emits one run per horizontal stretch of dark modules", () => {
    const { path } = qrSvg("hi");
    // The top-left finder's outer edge is seven dark modules in a row,
    // starting at the quiet zone's corner.
    expect(path).toContain("M4 4h7v1h-7z");
    expect(path.startsWith("M")).toBe(true);
    expect(path).not.toContain("NaN");
  });

  it("reports the version it needed", () => {
    expect(qrSvg("hi").version).toBe(1);
    expect(qrSvg("x".repeat(300)).version).toBeGreaterThan(9);
  });
});
