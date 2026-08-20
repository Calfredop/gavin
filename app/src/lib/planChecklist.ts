// Pure checklist parsing for card files (card-model spec §3). Line
// indices address the FULL file content (frontmatter included) so
// writers can rewrite the exact line; items live only in the body.

export interface ChecklistItem {
  lineIndex: number;
  text: string;
  checked: boolean;
  // Set when the item was promoted to a task card: the linked file name
  // from `- [ ] [text](./file.md)`.
  promotedFile: string | null;
}

const ITEM_RE = /^\s*- \[( |x)\] (.*)$/;
const LINK_RE = /^\[(.*)\]\((?:\.\/)?([A-Za-z0-9._-]+\.md)\)$/;

// The index of the first body line: 0 for no frontmatter, the line
// after the closing --- otherwise. An unterminated block has no body.
function bodyStart(lines: string[]): number | null {
  if (lines[0] !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") return i + 1;
  }
  return null;
}

export function parseChecklist(content: string): ChecklistItem[] {
  const lines = content.split("\n");
  const start = bodyStart(lines);
  if (start === null) return [];
  const items: ChecklistItem[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const m = ITEM_RE.exec(lines[i]);
    if (!m) continue;
    const raw = m[2];
    const link = LINK_RE.exec(raw);
    items.push({
      lineIndex: i,
      text: link ? link[1] : raw,
      checked: m[1] === "x",
      promotedFile: link ? link[2] : null,
    });
  }
  return items;
}

export function stripFrontmatter(content: string): string {
  const lines = content.split("\n");
  const start = bodyStart(lines);
  if (start === null) return "";
  if (start === 0) return content;
  return lines.slice(start).join("\n");
}
