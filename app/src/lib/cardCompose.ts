// Pure half of the two-speed composer (card-model spec §4): title +
// kind + context -> the createPlan argument set, with slugged file
// names and "-2" collision suffixes. The Svelte composer only renders
// and forwards.

import { slugFileName } from "./planExplorer";

export interface ComposeSpec {
  kind: "note" | "task" | "plan";
  title: string;
  // The prompt for a task, the body for a plan, ignored-when-empty for
  // a note.
  body: string;
  status: string; // the column's name
}

export type ComposeArgs =
  | {
      fileName: string;
      title: string;
      status: string;
      body: string | undefined;
      kind: "note" | "task" | "plan";
    }
  | { error: string };

export function buildCreatePlanArgs(spec: ComposeSpec, existingFileNames: string[]): ComposeArgs {
  const title = spec.title.trim();
  if (!title) return { error: "Card title is empty" };
  const base = slugFileName(title);
  if (!base) return { error: "Title has no usable characters for a file name" };
  const taken = new Set(existingFileNames);
  let fileName = base;
  let n = 2;
  while (taken.has(fileName)) {
    fileName = base.replace(/\.md$/, `-${n}.md`);
    n += 1;
  }
  const body = spec.body.trim();
  return { fileName, title, status: spec.status, body: body === "" ? undefined : body, kind: spec.kind };
}

/// Which column a freshly opened composer starts in. The column that
/// asked wins while it is still on the board -- a rename or a delete
/// between the click and the render must not leave the picker showing a
/// status no column carries -- and the leftmost column is the fallback,
/// which is what ⌘N gets when nothing asked for a particular one.
/// Null only when the board has no real columns at all: there is then no
/// status to give the card.
export function defaultComposeStatus(columnNames: string[], preferred: string | null): string | null {
  if (preferred !== null && columnNames.includes(preferred)) return preferred;
  return columnNames[0] ?? null;
}

/// The rail a newly created card should be sent to. A note never rides a
/// rail (it is not runnable work), and a rail deleted since the picker
/// rendered took its row off screen with it -- writing to it would be a
/// placement nobody asked for.
export function railToApply(
  kind: ComposeSpec["kind"],
  railId: string | null,
  railIds: string[]
): string | null {
  if (kind === "note" || !railId) return null;
  return railIds.includes(railId) ? railId : null;
}
