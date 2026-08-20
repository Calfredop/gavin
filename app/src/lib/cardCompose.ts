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
