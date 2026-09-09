// The inline column composer's rules (board spec §6). A text field that
// files a new column and, unlike every other composer in the app, is
// expected to be used SEVERAL times in a row -- naming a board's columns
// is one sitting, not one decision. That is the whole shape below: Enter
// commits and stays, blur commits and goes, Escape throws the text away.
//
// Pure because the rules are three-way and the field is not: what a
// keypress means, and what a commit does with the text it is holding,
// are answerable without an input element to type into.

/// What the composer does when it commits.
export interface ColumnComposerCommit {
  /// The column to create, trimmed -- or null when the field held only
  /// whitespace, which is not a column and must not become one.
  name: string | null;
  /// Whether the field stays open for the next name.
  open: boolean;
  /// Whether the field takes focus back. Only on the route that stays
  /// open: refocusing a field that is closing would steal the caret from
  /// wherever the human just clicked.
  refocus: boolean;
}

/// Commit the draft. `keepOpen` is the caller's route, not a preference:
/// Enter keeps typing, a blur has already left.
export function commitColumnDraft(draft: string, keepOpen: boolean): ColumnComposerCommit {
  const name = draft.trim();
  return { name: name === "" ? null : name, open: keepOpen, refocus: keepOpen };
}

/// What a keypress in the field means.
///
/// - `commit` — Enter: file this name and keep the field open.
/// - `cancel` — Escape: drop the text, close, create nothing. Escape must
///   NOT commit, or a human backing out of a half-typed name gets a
///   column called what they were in the middle of not saying.
/// - `null` — every other key is the input's own business.
export type ColumnComposerKey = "commit" | "cancel" | null;

export function columnComposerKey(key: string): ColumnComposerKey {
  if (key === "Enter") return "commit";
  if (key === "Escape") return "cancel";
  return null;
}
