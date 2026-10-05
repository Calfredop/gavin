// The Demo Workstation's cards, as files.
//
// A Workstation's board is read off card files: the daemon scans each
// context's `plans/` and parses what it finds, and every write -- a
// status, a tick, an answer -- is an edit to one file that the next scan
// reads back. This is just enough of that model for the demo to answer
// the board's and the card's commands the way a Workstation would, in
// the daemon's own spellings (`crates/daemon/src/gavin.rs`), so what the
// phone writes is what it reads back and what a reviewer sees on disk.
//
// Pure: text in, text out. Where the files live and who is told about a
// change is cardCommands.ts.
import { parseAttachments } from "$lib/cards/attachments";
import { parseComplexity } from "$lib/cards/complexity";
import { bodyStart, parseChecklist } from "$lib/cards/planChecklist";
import type { GavinContext, GavinTree, HumanItem, HumanItemOutcome, PlanFileInfo } from "$lib/core/gavin";
import { slugStatus } from "$lib/core/planBoard";

/// A demo file has no clock behind it. Every card reads as written at the
/// one moment, so a machine that was written to and put back compares
/// equal to the one that never was.
export const DEMO_MODIFIED_AT = 1_790_000_000;

const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
const KINDS = ["note", "task", "plan"] as const;

/// Where a context's cards live: `plans/`, and in it the two folders the
/// daemon files cards into by itself or at the human's word.
export const DONE_DIR = "done";
export const ARCHIVE_DIR = "archive";

// ---- Reading ---------------------------------------------------------

/// The frontmatter's `key: value` lines, and the index of the closing
/// `---`. Null when the file has no frontmatter block.
function frontmatter(lines: string[]): { fields: Map<string, string>; close: number } | null {
  if (lines[0] !== "---") return null;
  const close = lines.indexOf("---", 1);
  if (close === -1) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, close)) {
    const cut = line.indexOf(":");
    if (cut === -1) continue;
    const key = line.slice(0, cut).trim();
    if (!fields.has(key)) fields.set(key, line.slice(cut + 1).trim());
  }
  return { fields, close };
}

const HUMAN_MARKERS: [string, HumanItem["kind"]][] = [
  ["Decision:", "decision"],
  ["Human test:", "test"],
];

/// `A) keep it B) drop it`, the shape `file_human_item` writes, else `|`,
/// else one whole option (`split_options`).
function splitOptions(rest: string): string[] {
  const text = rest.trim();
  if (!text) return [];
  const labelled = [...text.matchAll(/(?:^|\s)[A-Za-z0-9][).]\s/g)];
  if (labelled.length > 0) {
    return labelled
      .map((m, i) => {
        const start = (m.index ?? 0) + m[0].length;
        const end = labelled[i + 1]?.index ?? text.length;
        return text.slice(start, end).trim();
      })
      .filter((o) => o !== "");
  }
  if (text.includes("|")) return text.split("|").map((o) => o.trim()).filter((o) => o !== "");
  return [text];
}

/// What an `Answer (…)` / `Result (…)` / `Ready for re-test (…)` line says
/// about its item, or null for a line that records no outcome.
function outcomeState(line: string): HumanItem["state"] | null {
  const lower = line.toLowerCase();
  if (lower.startsWith("answer (")) return "answered";
  if (lower.startsWith("ready for re-test (")) return "open";
  if (lower.startsWith("result (")) {
    const verdict = line.split("):")[1]?.trim().toLowerCase() ?? "";
    if (verdict.startsWith("passed")) return "passed";
    if (verdict.startsWith("failed")) return "failed";
  }
  return null;
}

const ITEM = /^(\s*)- \[( |x)\] (.*)$/;

/// One past the last line attached to the item at `at`: its indented
/// continuation, up to a blank line, a line no deeper than the item, or
/// another checklist item (`attached_block_end`).
function blockEnd(lines: string[], at: number, indent: number): number {
  let end = at + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "" || ITEM.test(line)) break;
    if (line.length - line.trimStart().length <= indent) break;
    end += 1;
  }
  return end;
}

/// Every `Decision:` / `Human test:` line in a card's body, with what has
/// been written under it (`human_items`).
export function humanItems(content: string): HumanItem[] {
  const lines = content.split("\n");
  const start = bodyStart(lines);
  if (start === null) return [];
  const items: HumanItem[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = ITEM.exec(lines[i]);
    if (!m) continue;
    const [, indent, mark, rest] = m;
    const marker = HUMAN_MARKERS.find(([prefix]) => rest.startsWith(prefix));
    if (!marker) continue;
    let options: string[] = [];
    let latest: string | null = null;
    let state: HumanItem["state"] = "open";
    for (const line of lines.slice(i + 1, blockEnd(lines, i, indent.length))) {
      const trimmed = line.trim();
      if (options.length === 0 && trimmed.toLowerCase().startsWith("options:")) {
        options = splitOptions(trimmed.slice("options:".length));
        continue;
      }
      const s = outcomeState(trimmed);
      if (s !== null) {
        latest = trimmed;
        state = s;
      }
    }
    items.push({
      kind: marker[1],
      text: rest.slice(marker[0].length).trim(),
      done: mark === "x",
      options,
      latest,
      state,
      lineText: rest,
      lineIndex: i,
    });
  }
  return items;
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/// What the daemon's scan says about one card file (`plan_file_info`).
export function readCard(path: string, content: string): PlanFileInfo {
  const fm = frontmatter(content.split("\n"));
  const field = (key: string): string | null => fm?.fields.get(key) || null;
  const priority = field("priority")?.toLowerCase() ?? null;
  const kind = field("kind") ?? "plan";
  const order = field("order");
  const checklist = parseChecklist(content);
  const fileName = fileNameOf(path);
  return {
    path,
    fileName,
    title: field("title") ?? fileName.replace(/\.md$/, ""),
    status: field("status"),
    priority: (PRIORITIES as readonly string[]).includes(priority ?? "")
      ? (priority as PlanFileInfo["priority"])
      : null,
    order: order !== null && /^-?\d+$/.test(order) ? Number(order) : null,
    kind: (KINDS as readonly string[]).includes(kind) ? (kind as PlanFileInfo["kind"]) : "plan",
    parent: field("parent"),
    labels: (field("labels") ?? "")
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
    checklistDone: checklist.filter((item) => item.checked).length,
    checklistTotal: checklist.length,
    parseWarning: fm === null,
    modifiedAt: DEMO_MODIFIED_AT,
    attachments: parseAttachments(field("attachments")),
    complexity: parseComplexity(field("complexity")),
    agent: field("agent"),
    model: field("model"),
    effort: field("effort"),
    humanItems: humanItems(content),
  };
}

// ---- Writing ---------------------------------------------------------

/// Sets one frontmatter field, or removes its line for an empty value
/// (`write_plan_field`). A field the block lacks goes in at its top.
export function withField(content: string, key: string, value: string): string {
  const lines = content.split("\n");
  const fm = frontmatter(lines);
  if (!fm) {
    return value === "" ? content : ["---", `${key}: ${value}`, "---", ...lines].join("\n");
  }
  const at = lines.slice(1, fm.close).findIndex((l) => l.split(":")[0].trim() === key);
  if (value === "") {
    if (at !== -1) lines.splice(at + 1, 1);
  } else if (at !== -1) {
    lines[at + 1] = `${key}: ${value}`;
  } else {
    lines.splice(1, 0, `${key}: ${value}`);
  }
  return lines.join("\n");
}

/// Ticks or unticks one checklist line, refusing when the line no longer
/// reads what the caller saw (`set_checklist_item`).
export function withChecklistItem(content: string, lineIndex: number, expected: string, checked: boolean): string {
  const lines = content.split("\n");
  const m = ITEM.exec(lines[lineIndex] ?? "");
  if (!m || m[3] !== expected) {
    throw new Error(`checklist item changed on disk — line ${lineIndex + 1} no longer reads ${JSON.stringify(expected)}`);
  }
  lines[lineIndex] = `${m[1]}- [${checked ? "x" : " "}] ${m[3]}`;
  return lines.join("\n");
}

function oneLine(text: string): string {
  return text
    .split(/[\r\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join(" ");
}

/// Writes the human's answer under a human item and sets its box
/// (`resolve_human_item`): an answer and a pass tick it, a plain fail
/// leaves the check owed.
export function withHumanOutcome(content: string, expected: string, outcome: HumanItemOutcome, today: string): string {
  const matches = humanItems(content).filter((i) => i.lineText === expected);
  if (matches.length === 0) {
    throw new Error(`human item changed on disk — no checklist item reads ${JSON.stringify(expected)} any more`);
  }
  if (matches.length > 1) throw new Error(`ambiguous: ${matches.length} human items read ${JSON.stringify(expected)}`);
  const failed = (note: string): string =>
    oneLine(note) ? `Result (${today}): failed — ${oneLine(note)}` : `Result (${today}): failed`;
  let written: string;
  let checked: boolean;
  switch (outcome.kind) {
    case "answer":
      if (!outcome.text.trim()) throw new Error("an answer needs text");
      [written, checked] = [`Answer (${today}): ${oneLine(outcome.text)}`, true];
      break;
    case "pass":
      [written, checked] = [`Result (${today}): passed`, true];
      break;
    case "fail":
      [written, checked] = [failed(outcome.note), false];
      break;
    case "failAndClose":
      [written, checked] = [failed(outcome.note), true];
      break;
  }
  const lines = content.split("\n");
  const at = matches[0].lineIndex;
  const indent = lines[at].length - lines[at].trimStart().length;
  lines[at] = `${lines[at].slice(0, indent)}- [${checked ? "x" : " "}] ${expected}`;
  lines.splice(blockEnd(lines, at, indent), 0, `${" ".repeat(indent + 2)}${written}`);
  return lines.join("\n");
}

export interface NewCard {
  title: string;
  kind: "note" | "task" | "plan";
  status: string | null;
  parent?: string | null;
  priority?: string | null;
  attachments?: string | null;
  complexity?: string | null;
  labels?: string | null;
  order?: number | null;
  body?: string | null;
}

/// A new card's text, laid out as `create_plan_file` lays it out: a plan
/// says no kind, and an empty body is the title as a heading. The demo's
/// own sample cards are written through here too, with the two fields
/// create_plan never writes (labels, order) where a sample carries them.
export function newCardText(card: NewCard): string {
  const lines = ["---"];
  if (card.kind !== "plan") lines.push(`kind: ${card.kind}`);
  lines.push(`title: ${card.title}`);
  if (card.status) lines.push(`status: ${card.status}`);
  if (card.parent) lines.push(`parent: ${card.parent}`);
  if (card.priority) lines.push(`priority: ${card.priority}`);
  if (card.order !== undefined && card.order !== null) lines.push(`order: ${card.order}`);
  if (card.labels) lines.push(`labels: ${card.labels}`);
  if (card.attachments) lines.push(`attachments: ${card.attachments}`);
  if (card.complexity) lines.push(`complexity: ${card.complexity}`);
  lines.push("---");
  const body = card.body?.trim();
  return `${lines.join("\n")}\n${body ? body : `# ${card.title}`}\n`;
}

// ---- Where a card belongs --------------------------------------------

/// The `plans/` folder a card path is filed under, and where in it.
export function plansRootOf(path: string): string | null {
  const at = path.lastIndexOf("/plans/");
  return at === -1 ? null : path.slice(0, at + "/plans".length);
}

export function isArchived(path: string): boolean {
  const root = plansRootOf(path);
  return root !== null && path.startsWith(`${root}/${ARCHIVE_DIR}/`);
}

/// The folder a card belongs in by its own fields: a Done card in
/// `done/`, a nested task beside its parent, everything else in `plans/`
/// (`relocate_for_status`). The archive is the human's folder and is left
/// alone here.
export function homeFolder(
  plansRoot: string,
  card: Pick<PlanFileInfo, "kind" | "parent" | "status">,
  parentFolder: string | null
): string {
  if (card.kind === "task" && card.parent && card.status === null && parentFolder) return parentFolder;
  if (card.status !== null && slugStatus(card.status) === DONE_DIR) return `${plansRoot}/${DONE_DIR}`;
  return plansRoot;
}

export function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/// The folder that holds a context's `plans/`: `.gavin-root` for a
/// workspace's root, `.gavin` for any other context.
export function markerOf(kind: GavinContext["kind"]): string {
  return kind === "root" ? ".gavin-root" : ".gavin";
}

/// A context's cards, as a scan finds them on disk: `plans/` and its
/// `done/` and `archive/`, in path order.
export function scanPlans(context: Pick<GavinContext, "folderPath" | "kind">, files: Record<string, string>): PlanFileInfo[] {
  const root = `${context.folderPath}/${markerOf(context.kind)}/plans/`;
  return Object.keys(files)
    .filter((path) => {
      if (!path.startsWith(root) || !path.endsWith(".md")) return false;
      const rest = path.slice(root.length).split("/");
      return rest.length === 1 || (rest.length === 2 && [DONE_DIR, ARCHIVE_DIR].includes(rest[0]));
    })
    .sort()
    .map((path) => readCard(path, files[path]));
}

/// A tree with every context's cards read again from `files`: what the
/// daemon's watcher pushes after a card is written.
export function rescan(tree: GavinTree, files: Record<string, string>): GavinTree {
  return { ...tree, contexts: tree.contexts.map((ctx) => ({ ...ctx, plans: scanPlans(ctx, files) })) };
}
