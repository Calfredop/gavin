// A QR encoder, byte mode, error-correction level M, written out here
// rather than installed.
//
// WHY NOT A DEPENDENCY. The one thing this encoder draws is a pairing
// secret: `protocol::PairingQr`'s compact JSON, which carries the
// daemon's static public key and a two-minute one-time secret
// (`docs/security/05-remote-access.md` §3). A package that draws it sees
// it, so the package would be inside the trust boundary of the very
// ceremony this feature exists to make safe -- and a QR library is
// exactly the kind of small, rarely-audited, deeply-transitive dependency
// that a supply-chain attack goes looking for. `npm test` never runs
// against a registry, but an install does, and the blast radius of a bad
// version here is "every phone paired since". The alternative is a few
// hundred lines of ISO/IEC 18004, which is a frozen spec: it will never
// need an upgrade, it has no transitive anything, and its output is
// checkable against a published vector (see qr.test.ts).
//
// It is also not general-purpose, deliberately. Byte mode only, because
// the payload is JSON; level M only, because the QR is read once at arm's
// length off a bright screen and M is the ordinary choice there; no
// kanji, no ECI, no structured append. Every one of those is a branch
// nobody in gavin would exercise, and an unexercised branch in a
// hand-written encoder is worse than no branch at all.
//
// The algorithm is the spec's, in the arrangement Project Nayuki's
// reference implementation made the common one: encode -> pick a version
// -> pad -> Reed-Solomon per block -> interleave -> place -> mask -> pick
// the mask by penalty. Names and comments are this repo's.

/// Error-correction level M's format bits (L=1, M=0, Q=3, H=2). Kept as
/// a named constant rather than a literal 0 because "zero" reads like
/// "unset" in the format-bit arithmetic below, and it is not.
const EC_LEVEL_M_FORMAT_BITS = 0;

/// EC codewords per block, level M, indexed by version (1..40). Index 0
/// is unused -- there is no version 0.
const EC_CODEWORDS_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/// Blocks the data is split into, level M, indexed by version (1..40).
const EC_BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/// Penalty weights from the spec's mask-evaluation rules, in its order:
/// a run of five or more, a 2x2 block of one colour, a finder-like
/// 1:1:3:1:1 run, and the dark/light imbalance.
const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER_LIKE = 40;
const PENALTY_IMBALANCE = 10;

export interface QrMatrix {
  /// Modules per side, WITHOUT the quiet zone.
  size: number;
  /// The symbol version, 1..40. Exposed for tests and for a caller that
  /// wants to say how dense the code got.
  version: number;
  /// The data mask the penalty scoring picked, 0..7.
  mask: number;
  /// `modules[y][x]` -- true is dark. Row-major, like the spec's
  /// coordinates.
  modules: boolean[][];
}

/// Encodes `text` (as UTF-8) into the smallest level-M symbol that holds
/// it. Throws when it does not fit any version, which for this feature
/// means a relay URL of some thousands of characters -- a real answer,
/// and one the caller shows rather than drawing an unreadable code.
export function encodeQr(text: string): QrMatrix {
  const data = new TextEncoder().encode(text);
  const version = smallestVersionFor(data.length);
  if (version === null) {
    throw new Error(`${data.length} bytes is too much for a QR code (the limit is ${maxBytes()})`);
  }
  const codewords = padToCapacity(bitsForSegment(data, version), version);
  const withEcc = addEccAndInterleave(codewords, version);
  return draw(withEcc, version);
}

/// The dark modules as one SVG path, plus the side of the square that
/// path is drawn in. The quiet zone is part of the symbol, not decoration
/// -- a QR pressed against a window frame is a QR a camera cannot find --
/// so it is in the returned `size` and the modules are offset into it.
///
/// One `h`-run per horizontal stretch rather than one rect per module:
/// a version-10 code is 57x57, and a path with three thousand
/// four-command subpaths is a string the webview re-parses on every
/// repaint of the dialog.
export function qrSvgPath(matrix: QrMatrix, quietZone = 4): { size: number; path: string } {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    let x = 0;
    while (x < matrix.size) {
      if (!matrix.modules[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < matrix.size && matrix.modules[y][x + run]) run++;
      parts.push(`M${x + quietZone} ${y + quietZone}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return { size: matrix.size + quietZone * 2, path: parts.join("") };
}

/// Both halves at once, for a template that wants nothing but a `d` and a
/// `viewBox`. Kept beside the encoder so the quiet zone is decided in one
/// place.
export function qrSvg(text: string, quietZone = 4): { size: number; path: string; version: number } {
  const matrix = encodeQr(text);
  const { size, path } = qrSvgPath(matrix, quietZone);
  return { size, path, version: matrix.version };
}

// -- sizing -----------------------------------------------------------

/// Total codewords a version holds, data and EC together: the raw data
/// modules divided by eight. Derived rather than tabulated -- the
/// arithmetic is the spec's and a table would be forty more numbers to
/// mistype.
function rawCodewords(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    modules -= (25 * alignCount - 10) * alignCount - 55;
    // The two version blocks, 6x3 each, only exist from v7.
    if (version >= 7) modules -= 36;
  }
  return Math.floor(modules / 8);
}

function dataCodewords(version: number): number {
  return rawCodewords(version) - EC_CODEWORDS_PER_BLOCK_M[version] * EC_BLOCKS_M[version];
}

/// Byte mode's character-count indicator is 8 bits up to v9 and 16 from
/// v10 -- which is why version choice and bit layout cannot be decided
/// independently of each other.
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function capacityBytes(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

function smallestVersionFor(byteLength: number): number | null {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    if (byteLength <= capacityBytes(v)) return v;
  }
  return null;
}

function maxBytes(): number {
  return capacityBytes(MAX_VERSION);
}

// -- bits -------------------------------------------------------------

/// Mode indicator 0100 (byte), the length, then the bytes.
function bitsForSegment(data: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, data.length, countBits(version));
  for (const byte of data) appendBits(bits, byte, 8);
  return bits;
}

function appendBits(bits: number[], value: number, width: number): void {
  for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/// Terminator, byte alignment, then the spec's alternating pad bytes.
function padToCapacity(bits: number[], version: number): number[] {
  const capacityBits = dataCodewords(version) * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

// -- Reed-Solomon over GF(256), primitive polynomial 0x11D -------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/// The generator polynomial for `degree` EC codewords: the product of
/// (x - a^i) for i in 0..degree-1, with the leading 1 left implicit.
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/// The EC codewords for one block. Exported because it is the piece with
/// a published test vector (ISO/IEC 18004's own worked example) and the
/// piece a silent mistake in would produce codes that scan on a good
/// phone and fail on a tired one.
export function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

/// Split into blocks, append each block's EC codewords, then interleave
/// the whole lot column-wise -- which is what makes a smudge across the
/// symbol a few lost codewords in every block rather than one block lost
/// entirely.
function addEccAndInterleave(data: number[], version: number): number[] {
  const blockCount = EC_BLOCKS_M[version];
  const eccLen = EC_CODEWORDS_PER_BLOCK_M[version];
  const total = rawCodewords(version);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLen = Math.floor(total / blockCount);

  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  let taken = 0;
  for (let i = 0; i < blockCount; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const block = data.slice(taken, taken + len);
    taken += len;
    const ecc = rsRemainder(block, divisor);
    // A placeholder so every block is the same length for the column
    // walk below; the walk skips it at exactly this index.
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }

  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(blocks[j][i]);
    }
  }
  return out;
}

// -- the symbol -------------------------------------------------------

interface Canvas {
  size: number;
  version: number;
  modules: boolean[][];
  /// Function patterns and reserved areas: never masked, never written
  /// over by data.
  reserved: boolean[][];
}

function draw(codewords: number[], version: number): QrMatrix {
  const size = version * 4 + 17;
  const canvas: Canvas = {
    size,
    version,
    modules: grid(size),
    reserved: grid(size),
  };
  drawFunctionPatterns(canvas);
  drawCodewords(canvas, codewords);

  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(canvas, mask);
    drawFormatBits(canvas, mask);
    const penalty = penaltyScore(canvas);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = mask;
    }
    // XOR is its own inverse, so the same call undoes it.
    applyMask(canvas, mask);
  }
  applyMask(canvas, best);
  drawFormatBits(canvas, best);
  return { size, version, mask: best, modules: canvas.modules };
}

function grid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

function setFunctionModule(c: Canvas, x: number, y: number, dark: boolean): void {
  c.modules[y][x] = dark;
  c.reserved[y][x] = true;
}

function drawFunctionPatterns(c: Canvas): void {
  for (let i = 0; i < c.size; i++) {
    setFunctionModule(c, 6, i, i % 2 === 0);
    setFunctionModule(c, i, 6, i % 2 === 0);
  }
  drawFinder(c, 3, 3);
  drawFinder(c, c.size - 4, 3);
  drawFinder(c, 3, c.size - 4);

  const align = alignmentPositions(c.version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      // The three finder corners already own these.
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0);
      if (!corner) drawAlignment(c, align[i], align[j]);
    }
  }

  // Reserve the format area with a placeholder; the real bits are
  // written once a mask has been chosen.
  drawFormatBits(c, 0);
  drawVersionBits(c);
}

/// The 7x7 finder with its one-module light separator, clipped at the
/// symbol's edge.
function drawFinder(c: Canvas, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < c.size && y >= 0 && y < c.size) {
        setFunctionModule(c, x, y, ring !== 2 && ring !== 4);
      }
    }
  }
}

function drawAlignment(c: Canvas, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunctionModule(c, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/// Alignment-pattern centres, derived rather than tabulated. v32 is the
/// one version the even-step arithmetic gets wrong, and the spec's table
/// is what settles it.
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFormatBits(c: Canvas, mask: number): void {
  const data = (EC_LEVEL_M_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;

  for (let i = 0; i <= 5; i++) setFunctionModule(c, 8, i, bit(bits, i));
  setFunctionModule(c, 8, 7, bit(bits, 6));
  setFunctionModule(c, 8, 8, bit(bits, 7));
  setFunctionModule(c, 7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) setFunctionModule(c, 14 - i, 8, bit(bits, i));

  for (let i = 0; i < 8; i++) setFunctionModule(c, c.size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) setFunctionModule(c, 8, c.size - 15 + i, bit(bits, i));
  // The one module that is dark in every symbol ever made.
  setFunctionModule(c, 8, c.size - 8, true);
}

function drawVersionBits(c: Canvas): void {
  if (c.version < 7) return;
  let rem = c.version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (c.version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = bit(bits, i);
    const a = c.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(c, a, b, dark);
    setFunctionModule(c, b, a, dark);
  }
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

/// The zigzag: two-module columns walked bottom-to-top then
/// top-to-bottom, right to left, skipping the vertical timing column.
function drawCodewords(c: Canvas, codewords: number[]): void {
  let i = 0;
  for (let right = c.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < c.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? c.size - 1 - vert : vert;
        if (!c.reserved[y][x] && i < codewords.length * 8) {
          c.modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function maskHolds(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/// XOR, so calling it twice with the same mask undoes it -- which is what
/// lets `draw` try all eight in place.
function applyMask(c: Canvas, mask: number): void {
  for (let y = 0; y < c.size; y++) {
    for (let x = 0; x < c.size; x++) {
      if (!c.reserved[y][x] && maskHolds(mask, x, y)) c.modules[y][x] = !c.modules[y][x];
    }
  }
}

// -- mask scoring -----------------------------------------------------

function penaltyScore(c: Canvas): number {
  let result = 0;
  const size = c.size;

  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (c.modules[y][x] === runColor) {
        runLength++;
        if (runLength === 5) result += PENALTY_RUN;
        else if (runLength > 5) result++;
      } else {
        addRunToHistory(runLength, history, size);
        if (!runColor) result += countFinderLike(history) * PENALTY_FINDER_LIKE;
        runColor = c.modules[y][x];
        runLength = 1;
      }
    }
    result += terminateRun(runColor, runLength, history, size) * PENALTY_FINDER_LIKE;
  }
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (c.modules[y][x] === runColor) {
        runLength++;
        if (runLength === 5) result += PENALTY_RUN;
        else if (runLength > 5) result++;
      } else {
        addRunToHistory(runLength, history, size);
        if (!runColor) result += countFinderLike(history) * PENALTY_FINDER_LIKE;
        runColor = c.modules[y][x];
        runLength = 1;
      }
    }
    result += terminateRun(runColor, runLength, history, size) * PENALTY_FINDER_LIKE;
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const colour = c.modules[y][x];
      if (
        colour === c.modules[y][x + 1] &&
        colour === c.modules[y + 1][x] &&
        colour === c.modules[y + 1][x + 1]
      ) {
        result += PENALTY_BLOCK;
      }
    }
  }

  let dark = 0;
  for (const row of c.modules) for (const module of row) if (module) dark++;
  const total = size * size;
  const off = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + off * PENALTY_IMBALANCE;
}

function addRunToHistory(runLength: number, history: number[], size: number): void {
  // The very first run is preceded by the quiet zone, which counts as
  // light modules for the 1:1:3:1:1 test.
  if (history[0] === 0) runLength += size;
  history.pop();
  history.unshift(runLength);
}

function terminateRun(runColor: boolean, runLength: number, history: number[], size: number): number {
  let length = runLength;
  if (runColor) {
    addRunToHistory(length, history, size);
    length = 0;
  }
  addRunToHistory(length + size, history, size);
  return countFinderLike(history);
}

/// The 1:1:3:1:1 ratio a finder pattern has, with four light modules on
/// one side -- the shape a decoder would mistake for a finder.
function countFinderLike(history: number[]): number {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (
    (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
    (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  );
}

// -- read-back, for tests ---------------------------------------------

/// Reverses `draw`: un-mask, walk the zigzag, de-interleave, and read the
/// byte-mode segment back out. Exported for `qr.test.ts`, which uses it
/// to prove placement, masking and the format bits are each other's
/// inverse over a real payload -- the property no structural assertion
/// reaches.
export function decodeQrForTest(matrix: QrMatrix): string {
  const size = matrix.size;
  // The reserved map is rebuilt from the version alone -- the same call
  // the encoder made, so a placement bug cannot hide behind a map that
  // was handed over with it.
  const canvas: Canvas = {
    size,
    version: matrix.version,
    modules: grid(size),
    reserved: grid(size),
  };
  drawFunctionPatterns(canvas);
  canvas.modules = matrix.modules.map((row) => [...row]);
  applyMask(canvas, matrix.mask);

  const interleaved: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (canvas.reserved[y][x]) continue;
        acc = (acc << 1) | (canvas.modules[y][x] ? 1 : 0);
        bits++;
        if (bits === 8) {
          interleaved.push(acc);
          acc = 0;
          bits = 0;
        }
      }
    }
  }

  const data = deinterleave(interleaved, matrix.version);
  const countWidth = countBits(matrix.version);
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >>> i) & 1));
  const take = (n: number, from: number): number =>
    stream.slice(from, from + n).reduce((v, b) => (v << 1) | b, 0);
  if (take(4, 0) !== 0b0100) throw new Error("not a byte-mode segment");
  const length = take(countWidth, 4);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = take(8, 4 + countWidth + i * 8);
  return new TextDecoder().decode(bytes);
}

function deinterleave(interleaved: number[], version: number): number[] {
  const blockCount = EC_BLOCKS_M[version];
  const eccLen = EC_CODEWORDS_PER_BLOCK_M[version];
  const total = rawCodewords(version);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLen = Math.floor(total / blockCount);

  const blocks: number[][] = Array.from({ length: blockCount }, () =>
    new Array<number>(shortLen + 1).fill(0)
  );
  let i = 0;
  for (let col = 0; col <= shortLen; col++) {
    for (let j = 0; j < blockCount; j++) {
      // The placeholder the interleave skipped, at exactly the index it
      // skipped it.
      if (col === shortLen - eccLen && j < shortBlocks) continue;
      blocks[j][col] = interleaved[i++];
    }
  }
  return blocks.flatMap((block, j) => block.slice(0, shortLen - eccLen + (j < shortBlocks ? 0 : 1)));
}
