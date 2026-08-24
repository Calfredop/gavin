// The one text matcher every search box in the app runs on. Pure and
// DOM-free so each surface's projection (board, rails, plans, git) can
// be unit-tested without a component.
//
// Semantics, deliberately boring: the query is split on whitespace and
// EVERY token must appear as a substring of SOME field, case-insensitive
// and order-independent. "git tab" finds "Git tab - worktrees" and "Tab
// for git" alike. No fuzzy subsequence matching -- on a board of short
// titles it produces more noise than hits.

/// A field a matcher reads. Nulls are normal (a card with no status, a
/// branch with no upstream) and are simply skipped.
export type Field = string | null | undefined;

export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/// Whether a query is asking for anything at all. Whitespace is not:
/// surfaces use this to decide whether they are in "filtering" mode
/// (which locks drags and re-labels counts).
export function isSearching(query: string): boolean {
  return queryTokens(query).length > 0;
}

export function matchesFields(tokens: string[], fields: Field[]): boolean {
  if (tokens.length === 0) return true;
  // One lower-cased haystack per call rather than per token: fields are
  // short, and this keeps the token loop allocation-free.
  const hay = fields
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .join(" ")
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

export function matchesQuery(query: string, fields: Field[]): boolean {
  return matchesFields(queryTokens(query), fields);
}

/// The list projection every flat surface (git file lists, the nav's
/// refs, the drawer's rows) uses. Returns the SAME array when nothing is
/// being searched, so callers can compare by identity to know they are
/// unfiltered.
export function filterList<T>(items: T[], query: string, fieldsOf: (item: T) => Field[]): T[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return items;
  return items.filter((item) => matchesFields(tokens, fieldsOf(item)));
}
