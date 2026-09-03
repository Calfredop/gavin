export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export interface Label {
  id: string;
  name: string;
  color: string;
}

// The card model made every card a file (card-model spec §1, C5): the
// SQLite board keeps only the column vocabulary (names = statuses, D6)
// and the label vocabulary (names referenced by cards' labels:
// frontmatter, slug-matched like columns).
export interface Column {
  id: string;
  name: string;
  position: number;
}

// A card file's live agent-session binding (card-model spec §3) --
// runtime state, never written into the card file.
export interface CardSession {
  path: string;
  sessionId: string;
  cwd: string;
  command: string | null;
  /// See orchestration.ts's StepRun: the conversation this run IS, and
  /// the directory it was LAUNCHED in (`cwd` above drifts with OSC 7).
  /// Optional because every binding recorded before v21 has neither.
  conversationId?: string | null;
  launchCwd?: string | null;
  /// See orchestration.ts's StepRun again: the persisted budget for
  /// unattended recovery (v22). Absent reads as zero -- a run gavin has
  /// never resumed by itself.
  resumeAttempts?: number | null;
  /// The commit this run's checkout sat on when the agent started
  /// (v26) -- what the Changes view diffs against and what a discard
  /// resets to. Absent for a run launched outside a repository, on an
  /// unborn HEAD, or against a daemon that could not store it: "no
  /// baseline", never "no changes".
  baseSha?: string | null;
}

export interface Board {
  columns: Column[];
  labels: Label[];
  cardSessions: CardSession[];
}

export function addColumn(board: Board, column: Column): Board {
  return { ...board, columns: [...board.columns, column] };
}

export function renameColumn(board: Board, columnId: string, name: string): Board {
  return {
    ...board,
    columns: board.columns.map((c) => (c.id === columnId ? { ...c, name } : c)),
  };
}

// CONTRACT: targetIndex counts positions AFTER the column's removal --
// the drag engine's hit-testing excludes the dragged column, so its
// indices are post-removal by construction.
export function reorderColumn(board: Board, columnId: string, targetIndex: number): Board {
  const currentIndex = board.columns.findIndex((c) => c.id === columnId);
  if (currentIndex === -1) return board;
  const columns = [...board.columns];
  const [moved] = columns.splice(currentIndex, 1);
  const clamped = Math.max(0, Math.min(targetIndex, columns.length));
  columns.splice(clamped, 0, moved);
  return { ...board, columns: columns.map((c, i) => ({ ...c, position: i })) };
}

// Deleting a column never touches card files: cards whose status matched
// it simply fall back to an auto column by status (D6).
export function deleteColumn(board: Board, columnId: string): Board {
  return {
    ...board,
    columns: board.columns.filter((c) => c.id !== columnId).map((c, i) => ({ ...c, position: i })),
  };
}

export function addLabel(board: Board, label: Label): Board {
  return { ...board, labels: [...board.labels, label] };
}

export function updateLabel(board: Board, labelId: string, patch: Partial<Pick<Label, "name" | "color">>): Board {
  return {
    ...board,
    labels: board.labels.map((l) => (l.id === labelId ? { ...l, ...patch } : l)),
  };
}

export function deleteLabel(board: Board, labelId: string): Board {
  return { ...board, labels: board.labels.filter((l) => l.id !== labelId) };
}
