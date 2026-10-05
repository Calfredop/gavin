// Path-shaped runs in a rendered terminal line. Every candidate costs a
// resolve round-trip on hover, so this is deliberately stricter than "any
// word": a false positive that resolves to nothing just never becomes
// clickable, but each extra match still costs.
//
// Leading alternatives, left-first:
//   - drive-qualified (`C:\…` / `C:/…`) — own arm so `:` stays out of the
//     run class (that exclusion stops `file.rs:12:5` suffixes being swallowed)
//   - UNC (`\\server\share\…`)
//   - home (`~/…`)
//   - relative with an explicit dot prefix (`./…`, `../…`, `.\…`, `..\…`)
//   - absolute `/…`, but not after an alphanumeric (kills `09/24/2026`)
//
// Spaces: a path containing a space cannot be found by a greedy non-space
// run. Leave it unmatched as a whole rather than probing progressively
// shorter prefixes — each probe is another round-trip per hovered line.
// A shorter non-space prefix may still match and the resolver rejects it.

export interface PathCandidate {
  text: string;
  /** 0-based index of `text` in the line. */
  index: number;
}

/** Path-shaped candidates in a rendered terminal line, in left-to-right order. */
export function pathCandidatesIn(text: string): PathCandidate[] {
  // Fresh `/g` regex each call: a shared one would keep `lastIndex`.
  const re =
    /(?:[A-Za-z]:[\\/]|\\\\|~\/|\.\.?[\\/]|(?<![0-9A-Za-z])\/)[^\s'"()[\]{}:,]+/g;
  return [...text.matchAll(re)].map((m) => ({
    text: m[0],
    index: m.index ?? 0,
  }));
}
