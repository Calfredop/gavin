// The dev-only manual test checklist rendered in the Smoke Test
// workspace. Data and persistence live here (pure, testable); the
// component only renders. Item ids are stable strings, never indexes --
// inserting a step must not silently re-tick a different one.

export interface ChecklistItem {
  id: string;
  text: string;
  hint?: string;
}

export interface ChecklistSection {
  title: string;
  items: ChecklistItem[];
}

export const SMOKE_SECTIONS: ChecklistSection[] = [
  {
    title: "Startup & daemon",
    items: [
      {
        id: "daemon-current",
        text: "App launches straight to the UI (no connection error)",
        hint: "A pre-MCP daemon triggers the version overlay instead — that's the probe working.",
      },
      {
        id: "daemon-restart-button",
        text: "Connection error overlay's “Restart daemon & retry” recovers without a terminal",
        hint: "Force it: pkill -x gavin-daemon after launch, then trigger any daemon action.",
      },
    ],
  },
  {
    title: "Root binding",
    items: [
      { id: "root-banner", text: "Unrooted workspace hub shows the “No root folder set” banner" },
      { id: "root-init", text: "Set root… → Initialize scaffolds .gavin-root (PRD, config, plans/docs/specs)" },
      { id: "root-persists", text: "Root chip survives an app restart" },
      {
        id: "root-missing",
        text: "Renaming the root away shows “Root not found”; renaming back heals it",
        hint: "Reactions take ~3s (watch debounce + rescan floor).",
      },
    ],
  },
  {
    title: "Board interaction",
    items: [
      {
        id: "drag-threshold",
        text: "A clean click opens the card modal; a tiny jiggle-and-release does too (no accidental drag)",
        hint: "Drag starts only after ~5px of movement.",
      },
      {
        id: "drag-placeholder",
        text: "Dragging shows a dashed placeholder gap that always matches where the card lands",
        hint: "The old bug: moving a card DOWN in its own column landed one slot too far. Verify that exact case.",
      },
      { id: "drag-tilt", text: "The dragged card floats tilted under the cursor and settles into its slot on release" },
      { id: "drag-escape", text: "Esc during a drag cancels it; the card slides home" },
      {
        id: "drag-autoscroll",
        text: "Dragging near the board's left/right edge scrolls the strip; near a tall column's top/bottom scrolls its list",
      },
      { id: "column-reorder", text: "Dragging a column by its header lands it exactly at the placeholder, both directions" },
      { id: "composer-card", text: "“+ Add card” opens an in-place field: Enter adds and stays, Esc closes, empty adds nothing" },
      { id: "composer-column", text: "“+ Add column” behaves the same way — no more literal “New column”" },
      {
        id: "save-failure",
        text: "Kill the daemon, drag a card → it snaps back and a “Couldn't save” banner appears; recovery clears it",
        hint: "pkill -x gavin-daemon, then drag. Restart daemon & retry via the error overlay if needed.",
      },
      { id: "board-refresh", text: "Refocusing the window refetches the board (free-form cards no longer go stale)" },
    ],
  },
  {
    title: "Plans on the board",
    items: [
      { id: "seed", text: "“Seed demo data” fills the board within ~3s" },
      { id: "plan-card", text: "Plan cards render dashed, with priority dot and context badge" },
      {
        id: "plan-reorder",
        text: "Reordering a plan card within its column writes order: lines only, and the order survives the ~3s watcher echo",
        hint: "First reorder in a column materializes order: for its plan block — that's expected.",
      },
      {
        id: "plan-restatus-order",
        text: "Dragging a plan card to another column writes status: plus order:, nothing else (check git diff)",
      },
      { id: "plan-auto-column", text: "An unmatched status (Shipped) makes an auto column; dragging out dissolves it" },
      { id: "plan-live", text: "Editing a plan file in a terminal moves its card by itself" },
      { id: "plan-modal", text: "Card click opens the detail modal; priority change writes the file" },
      { id: "plan-warning", text: "Broken frontmatter shows ⚠ and still renders the card" },
    ],
  },
  {
    title: "Markdown editing",
    items: [
      {
        id: "edit-modes",
        text: "A markdown file tab offers Formatted / Plain / Edit; a .rs file offers Plain / Edit",
      },
      { id: "edit-autosave", text: "Type in Edit, wait ~1s, check the file on disk — the change is there" },
      { id: "edit-save-key", text: "⌘S saves immediately; the tab's dirty dot clears" },
      {
        id: "edit-external-clean",
        text: "Edit the file in a terminal while the editor is clean → it reloads silently",
      },
      {
        id: "edit-conflict",
        text: "Type (don't wait), then edit the same file externally → conflict banner; both buttons behave",
        hint: "Keep mine = your text wins on the next save; Take theirs = buffer is replaced.",
      },
      { id: "edit-plan-card", text: "Editing a plan's status: line here moves its card on the board (~3s)" },
      { id: "edit-truncated", text: "A >1 MB file offers no Edit mode and says why" },
      { id: "edit-hub-tabs", text: "PRD and CLAUDE.md tabs appear only with a root bound, and open in Edit" },
      {
        id: "edit-creates",
        text: "With no CLAUDE.md, its tab opens empty and the first save creates the file",
      },
      {
        id: "edit-hidden-pane",
        text: "Open a file tab, switch to a sibling tab and back — the editor is full height, not collapsed",
      },
    ],
  },
  {
    title: "Plan explorer",
    items: [
      { id: "exp-tab", text: "A Plans tab appears once a root is bound; tree shows contexts → Plans/Docs/Specs" },
      { id: "exp-meta", text: "Plan rows show status, priority dot, and ⚠ for broken frontmatter" },
      { id: "exp-select", text: "Clicking a file opens it in the editor on the right" },
      {
        id: "exp-new-plan",
        text: "+ → Plans → title → Enter creates the file, selects it, and it appears on the board (~3s)",
      },
      {
        id: "exp-new-doc",
        text: "+ → Docs creates a doc; a title with no usable characters shows an inline error instead",
      },
      {
        id: "exp-new-context",
        text: "“+ context” picker: a folder inside the root scaffolds .gavin; one outside is refused with a reason",
      },
      { id: "exp-status", text: "Changing Status in the metadata panel moves the card on the board" },
      {
        id: "exp-title",
        text: "Changing the title updates the card and the tree row — the filename does NOT change",
      },
      {
        id: "exp-no-conflict",
        text: "Type in the editor, then immediately change Status — NO conflict banner appears",
        hint: "The panel flushes the editor before writing; a banner here means that flush regressed.",
      },
      { id: "exp-vanished", text: "Delete the selected file in a terminal → detail pane says it no longer exists" },
      {
        id: "exp-split",
        text: "The split icon on a file row opens it beside a terminal (hidden with no terminal session)",
      },
    ],
  },
  {
    title: "Context boards",
    items: [
      { id: "board-icon", text: "cd into a .gavin context → kanban icon appears on the pane tab bar" },
      { id: "board-tab", text: "Clicking it opens a “<context> · board” tab with only that context's plans" },
      { id: "board-persists", text: "The board tab survives an app restart" },
      { id: "board-missing", text: "Deleting the context folder shows “This context no longer exists”" },
    ],
  },
  {
    title: "Agent integration (MCP)",
    items: [
      { id: "mcp-setup", text: "“Set up / update” writes .mcp.json, the skill, and the CLAUDE.md block" },
      { id: "mcp-idempotent", text: "Re-running it preserves hand-written CLAUDE.md content outside the markers" },
      { id: "mcp-listed", text: "claude in that folder: /mcp lists gavin with 8 tools" },
      { id: "mcp-prd-plan", text: "Agent reads the PRD and creates a plan → card appears on the board" },
      { id: "mcp-status", text: "Agent sets a plan status → the card moves" },
      {
        id: "mcp-spawn",
        text: "gavin_spawn_session lands a live session on an “Agents” page without stealing focus",
      },
      { id: "mcp-board", text: "gavin_get_board returns the columns and your free-form cards" },
    ],
  },
  {
    title: "Terminal & viewer regressions",
    items: [
      { id: "term-basics", text: "Split/new tab/close still work; sessions survive an app restart" },
      { id: "viewer-open", text: "cmd+click a path in terminal output opens the file viewer split" },
      { id: "viewer-live", text: "Editing that file externally live-reloads the viewer" },
    ],
  },
];

export function totalItems(sections: ChecklistSection[] = SMOKE_SECTIONS): number {
  return sections.reduce((n, s) => n + s.items.length, 0);
}

export function storageKey(workspaceId: string): string {
  return `gavin.smokeChecklist.${workspaceId}`;
}

// Storage is injected (defaulting to the browser's) so this module stays
// testable under vitest's node environment, where localStorage doesn't
// exist at all.
type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/// Unknown/absent/corrupt payloads all read as "nothing checked" -- a
/// checklist that throws on a stale key would be worse than one that
/// forgets.
export function loadChecked(workspaceId: string, storage: MaybeStorage = defaultStorage()): Set<string> {
  try {
    const raw = storage?.getItem(storageKey(workspaceId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function saveChecked(
  workspaceId: string,
  checked: Set<string>,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    storage?.setItem(storageKey(workspaceId), JSON.stringify([...checked]));
  } catch {
    // Best-effort: a full/blocked storage must never break the checklist.
  }
}
