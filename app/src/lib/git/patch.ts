// Builds the single-hunk patch that `git apply` consumes for hunk and line
// staging (spec §3). The rules, for each line of the chosen hunk:
//   context            -> kept as context
//   add, selected      -> kept as "+"
//   add, unselected    -> dropped (it doesn't exist in the patch's target)
//   del, selected      -> kept as "-"
//   del, unselected    -> emitted as context (the line still exists)
// `selected === null` means the whole hunk. Lines keep their original
// order, matching `git add -p`'s edit semantics. The same patch serves
// stage (--cached), unstage (--cached -R) and discard (-R) because it is
// always expressed against the diff's own base.

import { lineId, type FileDiff } from "$lib/git/git";

export function buildPatch(diff: FileDiff, hunkIndex: number, selected: ReadonlySet<string> | null): string | null {
  const hunk = diff.hunks[hunkIndex];
  if (!hunk) return null;

  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let changes = 0;

  hunk.lines.forEach((line, i) => {
    const picked = selected === null || selected.has(lineId(hunkIndex, i));
    let prefix: " " | "+" | "-" | null;
    if (line.kind === "context") prefix = " ";
    else if (line.kind === "add") prefix = picked ? "+" : null;
    else prefix = picked ? "-" : " ";
    if (prefix === null) return;
    if (prefix !== "+") oldCount++;
    if (prefix !== "-") newCount++;
    if (prefix !== " ") changes++;
    body.push(prefix + line.text);
    if (line.noNewline) body.push("\\ No newline at end of file");
  });

  if (changes === 0) return null;

  const isNewFile = hunk.oldStart === 0 && hunk.oldLines === 0 && !diff.oldPath;
  const oldHeader = isNewFile ? "--- /dev/null" : `--- a/${diff.oldPath ?? diff.path}`;
  const header = `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`;
  return [oldHeader, `+++ b/${diff.path}`, header, ...body].join("\n") + "\n";
}
