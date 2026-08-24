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
      {
        id: "root-banner-no-picker",
        text: "The hub folder bar sits above the tabs and offers no picker — only “Open settings”, which jumps to the Settings tab",
      },
      {
        id: "root-init",
        text: "Settings → Set root… → Initialize scaffolds .gavin-root (PRD, config, plans/docs/specs)",
      },
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
      { id: "composer-card", text: "“+ Add card” opens the composer: Enter adds a note FILE in that column and stays, Esc closes, empty adds nothing" },
      { id: "composer-column", text: "“+ Add column” behaves the same way — no more literal “New column”" },
      {
        id: "save-failure",
        text: "Kill the daemon, rename or add a column → it reverts and a “Couldn't save” banner appears; recovery clears it",
        hint: "pkill -x gavin-daemon, then edit a column. Restart daemon & retry via the error overlay if needed.",
      },
      { id: "board-refresh", text: "Refocusing the window refetches the board (columns/labels no longer go stale)" },
      {
        id: "multi-select-shift",
        text: "Shift+click rings cards in accent and stacks them into a selection — across columns, auto columns and nested areas",
        hint: "Shift+DRAG must never move a card: the whole gesture is a pick. A plain click still opens the card and drops the selection; Esc drops it too.",
      },
    ],
  },
  {
    title: "Card kinds",
    items: [
      {
        id: "kind-compose-note",
        text: "Composer fast path: type a title, Enter → a kind: note .md lands in plans/ with status: <column>",
        hint: "cat the file — slugged name, note kind, the column's name as status.",
      },
      {
        id: "kind-compose-task",
        text: "Composer task chip: prompt textarea appears; the created file's body IS the prompt (kind: task)",
      },
      {
        id: "kind-compose-plan",
        text: "Composer plan chip: body textarea + context picker; plan cards show n/m checklist progress",
      },
      {
        id: "kind-nested-display",
        text: "A task with parent: <plan file> and NO status renders inside the plan card's expandable area",
        hint: "Create via gavin_create_plan (kind task, parent set) or hand-author; chevron shows the child count.",
      },
      {
        id: "kind-parent-chip",
        text: "A task with parent: AND a status stays in its column wearing the plan's title as a chip; a bad parent shows ⚠",
      },
      {
        id: "kind-detail-roundtrip",
        text: "Card detail: title/status/priority edits round-trip into the file; status select can free a nested child",
      },
      {
        id: "kind-labels",
        text: "Label chips in the detail write labels: names (slug-matched colors); clearing the last removes the line",
      },
      {
        id: "kind-tooltips",
        text: "Hovering card icons/chips and board buttons shows the styled in-app tooltip (350ms; hides on click/drag)",
      },
      {
        id: "delete-card",
        text: "Card hover × / detail Delete: confirm prompt spells out consequences; the .md file and its binding are gone",
        hint: "A deleted plan's nested tasks go with it; free-standing children get un-parented, not orphaned.",
      },
      {
        id: "delete-column-cascade",
        text: "Deleting a non-empty CUSTOM column offers three ways out: move cards to a picked column, leave them (auto column), or delete them",
        hint: "The picker lists every other real column; “move” rewrites each card's status: line.",
      },
      {
        id: "permanent-columns",
        text: "To Do / In Progress / Done can't be renamed or deleted — their red × CLEARS the cards, column stays; still drag-reorderable",
        hint: "Delete one via SQLite or an old board: the next board load restores it (empty, at the end).",
      },
      {
        id: "context-menu",
        text: "Right-click: cards get open/run-jump/move-to/un-parent/delete; column headers rename/add/run-all/delete; empty board adds columns",
      },
      {
        id: "kind-wipe",
        text: "No free-form SQLite cards anywhere — a pre-wipe database's cards are gone after the daemon restarts",
      },
    ],
  },
  {
    title: "Nesting & promotion",
    items: [
      {
        id: "nest-drag-in",
        text: "Dragging a task over a plan card auto-expands it; dropping inside writes parent: and removes status:",
        hint: "cat the task file — parent line present, status line gone; the card sits in the plan's nested area.",
      },
      {
        id: "nest-drag-out",
        text: "Dragging a nested child into a column writes status: (parent: stays; chip persists)",
      },
      {
        id: "nest-note-refuses",
        text: "Notes and plans refuse to nest — the middle of a plan card is a plain slot for them",
      },
      {
        id: "promote-ui",
        text: "Detail → Promote on a checklist item creates the nested task and rewrites the line to a link",
      },
      {
        id: "promote-mcp",
        text: "A real agent's gavin_promote_task does the same (check /mcp lists it)",
      },
      {
        id: "checklist-toggle",
        text: "Ticking a checkbox in the detail rewrites only that line; a concurrent file edit surfaces the retry message",
        hint: "Edit the plan body in a terminal while the modal is open, then tick.",
      },
      {
        id: "unparent",
        text: "Un-parent in the children list removes parent:; the card lands in the first column",
      },
    ],
  },
  {
    title: "Run & bindings",
    items: [
      {
        id: "run-task",
        text: "Hover pills: blue ▶ session spawns a dedicated bound agent (Agents page, attached, no focus steal) and sets In Progress",
        hint: "The composed command is agentCommand + the quoted prompt; cwd = the card's context folder.",
      },
      {
        id: "run-plan",
        text: "▶ session on a plan hands the agent a pointer prompt (read the file, tick items, promote, keep status)",
      },
      {
        id: "run-dot",
        text: "A bound card shows the session dot (working/waiting/idle/exited ring), same vocabulary as terminal tabs",
      },
      {
        id: "run-jump-not-double",
        text: "Run on a card with a live session jumps to it — never a second spawn",
      },
      {
        id: "run-dot-jump",
        text: "Clicking a card's status dot jumps straight to the session; an exited dot opens the detail (Re-launch)",
        hint: "Waiting-for-input pulses red; the card edge tints with the session status.",
      },
      { id: "run-relaunch", text: "After the session exits, Re-launch in the detail recreates it with the same cwd/command" },
      { id: "run-unlink", text: "Unlink clears the dot and the binding; the next Run spawns fresh" },
      {
        id: "run-send-agent",
        text: "Green ▶ agent pill pastes the prompt into the RUNNING main agent and jumps Home; disabled (with tooltip) when none runs",
        hint: "No binding/dot for main-agent sends — the card's status is the tracking.",
      },
      { id: "run-now-composer", text: "Composer task chip + “Run now” creates the card and immediately runs it" },
      {
        id: "run-selected",
        text: "The selection bar's ▶ Run selected spawns one session per picked UNBOUND card, one after another, then clears the selection",
        hint: "Its count excludes notes and already-bound cards; pick only those and the button is disabled with a tooltip saying why.",
      },
      {
        id: "run-column-verbs",
        text: "Column run buttons speak their column: To Do “Start all”, In Progress “Resume” (↺ icon), Done has none; custom columns keep “Run all”",
        hint: "Right-click the header too — the menu entry carries the same verb and the same count.",
      },
      {
        id: "run-resume-stopped",
        text: "Resume targets every In Progress card with no LIVE session — an exited binding counts — and spawns the gavin-resume prompt",
        hint: "A card whose session is alive is skipped, not double-run; the spawned command starts “Use the gavin-resume skill…”.",
      },
      {
        id: "run-names-its-tab",
        text: "A launched agent renames its own tab within the first few seconds — short and about the card, not “gavin”",
        hint: "Run two cards at once: both tabs should be tellable apart at a glance. Board Run, Resume and an orchestration launch all carry the instruction.",
      },
      {
        id: "run-tab-card-link",
        text: "A bound agent's tab shows the ↗ card link; it opens the Kanban tab with that card's detail modal already up",
        hint: "Unbound terminals (and file/board tabs) show no link at all. Unlink the card and the link goes away.",
      },
      {
        id: "run-tab-card-link-rail",
        text: "For a card sitting on an orchestration rail the same ↗ opens the Orchestration tab instead — with the same detail modal",
        hint: "Works on a cold start too: the plan is fetched by the tab, not only by the Orchestration tab having been visited.",
      },
      {
        id: "run-sidebar-card-link",
        text: "Expanding a page in the sidebar puts the same ↗ on the bound agent's row, and it makes the same jump",
        hint: "Click the arrow, not the row: the row must NOT also switch to the terminal. Then try it on a page belonging to a workspace you are NOT in — the jump has to activate that workspace, not flip its hub view behind your back.",
      },
      {
        id: "skill-updated",
        text: "Re-run “Set up agent integration”: SKILL.md teaches name-your-tab-first, kinds, nesting, promotion, tick-when-done; gavin-orchestrate and gavin-resume land beside it",
      },
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
    title: "Archiving Done cards",
    items: [
      {
        id: "arch-round-trip",
        text: "Set a card to Done on the board → its file moves into plans/done/; set it back to To Do → it returns to plans/",
        hint: "Watch the file in a terminal: ls .gavin-root/plans/done/. The board itself should look unchanged.",
      },
      {
        id: "arch-modal-open",
        text: "Open a card's modal, set Status → Done from inside it — the modal STAYS open and keeps editing the same card",
        hint: "This is the regression the move creates: the host holds the card by path. A modal that vanishes here means onPathChange regressed.",
      },
      {
        id: "arch-nested-children",
        text: "A plan with nested task cards archived to Done takes its children with it; bringing it back brings them too",
      },
      {
        id: "arch-run-archived",
        text: "Run a Done card → it leaves done/ first and the agent's prompt names the plans/ path, not the done/ one",
        hint: "Read the spawned terminal's first line: the path in it must not contain done/.",
      },
      {
        id: "arch-explorer-fold",
        text: "Plans tab: archived cards sit under one collapsed “Done” row with a count, not as loose siblings",
      },
      {
        id: "arch-explorer-search",
        text: "Searching for an archived card's title finds it and shows it as a normal row (not hidden behind the fold)",
      },
      {
        id: "arch-rail-follows",
        text: "A card placed on an orchestration rail keeps its place after being archived and un-archived",
        hint: "The rail's step is re-keyed to the new path; a step that goes blank means rename_card_path regressed.",
      },
      {
        id: "arch-rail-heals",
        text: "Move a card's file yourself (mv it into plans/done/ from a terminal) — its rail step follows on the next scan instead of the rail stalling on it",
        hint: "The daemon re-keys a step by file name when the path it holds goes missing. A step that reads “card file is missing”, or a rail that pauses on a finished card, means that recovery regressed.",
      },
      {
        id: "arch-drawer-count",
        text: "Orchestration: “Unplaced (n)” counts only cards still waiting — a Done card stays listed in its collapsed group but is out of the number, and an archived card is in neither the drawer nor + Add step",
        hint: "Archive a card sitting in the drawer and its row goes. Set one to Done and the row moves to the Done group while the header drops by one.",
      },
      {
        id: "arch-agent-told",
        text: "An agent calling gavin_set_plan_field(..., \"status\", \"Done\") is answered with the card's new path",
      },
    ],
  },
  {
    title: "Archiving closes what the card was using",
    items: [
      {
        id: "arch-close-session",
        text: "Archive a card with a RUNNING agent → a dialog names the count, and on OK the agent's tab is gone from its pane",
        hint: "Run a card, wait for the terminal, then right-click → Archive. Cancel must leave both the card and the agent exactly where they were.",
      },
      {
        id: "arch-close-file-tab",
        text: "Archive a card whose .md is open as a file tab and nothing is running → NO dialog, and the file tab closes on its own",
        hint: "Open the card from the Plans tab first. A file tab ends no process, so a prompt here would be noise.",
      },
      {
        id: "arch-close-relaunch",
        text: "Restore that card from the archive grid → its menu still offers “Re-launch agent”, not “Run in dedicated session”",
        hint: "The session dies but the binding survives, so the remembered cwd/command is still there. “Run in dedicated session” means the binding was dropped.",
      },
      {
        id: "arch-close-archive-all",
        text: "“Archive all” on the Done column asks ONCE for the whole batch, not once per card",
      },
    ],
  },
  {
    title: "Getting a card back out of the archive",
    items: [
      {
        id: "unarch-detail-modal",
        text: "Open an archived card from the archive grid → its footer reads “Restore from archive”; pressing it closes the modal and the card is back in its column",
        hint: "Open a card that is still on the board and the same button reads “Archive”. The modal closes on either, because the card's file has moved and the path the modal was opened with is gone.",
      },
      {
        id: "unarch-detail-status",
        text: "A card archived from Done comes back into Done, and one archived from To Do comes back into To Do",
        hint: "The status the card kept while archived is what picks the column — restoring never re-files it.",
      },
      {
        id: "unarch-plans-tab",
        text: "Plans tab → Archive group → right-click a card → “Restore from archive”; the row leaves the Archive group and the editor stays on the same file",
        hint: "The selection follows the move on its own for a card with no nested tasks. A plan that took children with it is more than one rename, so the pane may fall back to “this file no longer exists” — that is expected, not a bug.",
      },
      {
        id: "unarch-plans-tab-only-archive",
        text: "Right-click a row under Plans, Docs or Specs → NO restore entry (it belongs only to the Archive group)",
      },
    ],
  },
  {
    title: "Orchestration home",
    items: [
      { id: "home-default", text: "A rooted workspace opens on Home; one where you last chose another tab still opens there" },
      { id: "home-start", text: "Start main agent spawns a live agent at the workspace root, visible in the panel" },
      {
        id: "home-restart",
        text: "Quit and relaunch — the agent terminal is still live and scrolling, not blank",
        hint: "Blank means the bootstrap Attach for main sessions regressed (Milestone C's bug).",
      },
      { id: "home-stop", text: "Stop returns the panel to the launcher; the session is gone from the daemon" },
      { id: "home-external-exit", text: "Kill the agent from a terminal (or type exit) → panel returns to the launcher on its own" },
      { id: "home-no-respawn", text: "With an agent stopped, relaunching the app does NOT start one" },
      { id: "home-command", text: "Editing the command (e.g. claude --model opus) persists and is used on the next Start" },
      { id: "home-summaries", text: "PRD excerpt and board columns/counts match reality; changing the board updates the counts" },
      { id: "home-tiles", text: "Each of the four tiles navigates to its tab" },
      { id: "home-resize", text: "Resizing the window keeps the agent terminal correctly sized, not clipped" },
    ],
  },
  {
    title: "Workspace settings",
    items: [
      { id: "set-tab", text: "A Settings tab appears for every workspace, including one with no root bound" },
      { id: "set-name", text: "Renaming here updates the sidebar immediately and survives a restart" },
      {
        id: "set-colour",
        text: "Picking a palette colour tints the focused tab's top border and the sidebar stripe; a custom colour works too",
      },
      { id: "set-colour-preview", text: "The preview swatch shows the chosen colour before you look at the tabs" },
      { id: "set-root", text: "The embedded root control binds a folder, and no duplicate banner shows on the Settings tab" },
      {
        id: "set-notify",
        text: "Unticking “finished” silences that notification while “needs input” still fires",
        hint: "Unfocus the window; run a long command, then something needing input.",
      },
      { id: "set-profile", text: "Switching profile updates the CLAUDE.md tab's label and the home tile to the new file name" },
      {
        id: "set-rename-move",
        text: "Changing the agent file with the old one present prompts; Move renames it on disk with content intact",
      },
      {
        id: "set-rename-point",
        text: "When the target already exists, no move is offered and the old file is left alone",
      },
      { id: "set-rename-invalid", text: "A name with a slash, or an empty one, shows an inline error and changes nothing" },
      { id: "set-command", text: "Editing the command writes .gavin-root/config.toml and the next Start uses it" },
      {
        id: "set-external",
        text: "Editing config.toml in a terminal updates the panel (~3s); a field you're typing in is NOT clobbered",
        hint: "Focus the Command field, type, then edit config.toml externally.",
      },
      {
        id: "set-mcp-gated",
        text: "Every stock profile offers the agent-integration row, naming its own config file (Codex → .codex/config.toml)",
      },
      {
        id: "set-mcp-custom",
        text: "Custom shows MCP config + format fields; naming a file makes the agent-integration row appear",
        hint: "Then run it: the named file is written in the chosen dialect.",
      },
      {
        id: "set-mcp-settings-only",
        text: "The “Agent integration” row shows ONLY on the Settings tab — no other hub tab carries it",
      },
      { id: "set-unparseable", text: "Corrupting config.toml makes the agent fields read-only rather than overwriting it" },
    ],
  },
  {
    title: "Init wizard",
    items: [
      { id: "wiz-create", text: "Creating a workspace opens the setup modal; Continue is disabled until a folder is bound" },
      { id: "wiz-skip-create", text: "Skip setup leaves a usable, unrooted workspace — exactly as before" },
      { id: "wiz-steps", text: "The wizard opens on the first unfinished step and walks Agent → Integration → PRD → Launch" },
      {
        id: "wiz-resume",
        text: "Closing the wizard mid-way leaves the workspace usable; the Home tab offers “n of 4 done — continue”",
      },
      {
        id: "wiz-derived",
        text: "Doing a step by hand (bind a root, run Set up integration in Settings) marks it done without visiting the wizard",
        hint: "Progress is derived from disk, never stored — that's the property this checks.",
      },
      { id: "wiz-prd-fields", text: "Filling only Vision writes it into PRD.md and leaves the other two placeholders" },
      {
        id: "wiz-prd-agent",
        text: "“Ask the agent” starts the main agent already writing the PRD; Launch then says “already running”",
      },
      {
        id: "wiz-agent-gate",
        text: "With Cursor or opencode, “Ask the agent” is absent and the step says why; with Codex or Gemini it is offered",
        hint: "Those two take a path, not a prompt, in their bare positional — the other three take a prompt.",
      },
      {
        id: "wiz-integration-degrades",
        text: "With Codex selected, Integration writes AGENTS.md AND .codex/config.toml, and lists only the skill file as skipped",
        hint: "Both halves are behaviour changes: that profile once got nothing, and until sub-project B got no MCP config.",
      },
      {
        id: "wiz-integration-merges",
        text: "Re-running over a hand-edited config leaves the other servers, settings and TOML comments alone",
        hint: "Put a comment and a second server in .codex/config.toml first.",
      },
      { id: "wiz-complete", text: "Once all four are done the Home card disappears" },
      { id: "wiz-unfiled", text: "The Unfiled workspace never offers the wizard" },
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
      { id: "mcp-setup", text: "Settings → “Set up / update” writes .mcp.json, the skill, and the CLAUDE.md block" },
      { id: "mcp-idempotent", text: "Re-running it preserves hand-written CLAUDE.md content outside the markers" },
      { id: "mcp-listed", text: "claude in that folder: /mcp lists gavin with 12 tools" },
      { id: "mcp-prd-plan", text: "Agent reads the PRD and creates a plan → card appears on the board" },
      { id: "mcp-status", text: "Agent sets a plan status → the card moves" },
      {
        id: "mcp-spawn",
        text: "gavin_spawn_session lands a live session on an “Agents” page without stealing focus",
      },
      {
        id: "mcp-name-session",
        text: "gavin_name_session renames the CALLING agent's own tab, and the new name survives an app restart",
        hint: "It reads GAVIN_SESSION_ID from its PTY; run it from a terminal outside gavin and it says so instead of renaming something random.",
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
  {
    title: "Git tab",
    items: [
      {
        id: "git-tab-lists",
        text: "Git tab shows unstaged/staged lists for the workspace repo and refreshes within ~300 ms of `touch x` in a terminal",
      },
      {
        id: "git-partial-stage",
        text: "Select a few lines in a hunk → “Stage selected (n)” stages only those lines (staged diff shows them; unstaged keeps the rest)",
      },
      { id: "git-split-toggle", text: "Unified/Split toggle keeps the line selection and survives an app restart" },
      {
        id: "git-discard-untracked",
        text: "Trash on an untracked row says “Delete 1 untracked file?” and removes the file on confirm",
        hint: "Cancel must leave the file in place.",
      },
      {
        id: "git-discard-skip",
        text: "“Don't ask again for hunks and lines” suppresses the hunk dialog; file-level discard still asks",
      },
      {
        id: "git-hook-reject",
        text: "A failing pre-commit hook shows its stderr in the banner and keeps the commit draft",
        hint: "printf '#!/bin/sh\\nexit 1' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit",
      },
      {
        id: "git-amend",
        text: "Amend pre-fills HEAD's message when the draft is empty and restores the draft when unticked",
      },
      {
        id: "git-not-a-repo",
        text: "A rooted non-repo workspace shows “Initialize repository”; clicking it turns the tab live",
      },
      {
        id: "git-agent-commit",
        text: "Toolbar's “Commit via agent” (right of Stash/Pop, left of Refresh) opens NO tab, shows “Committing…”, ends with “Committed” plus the agent's commits in the list",
        hint: "The agent decides the chunks; expect more than one commit and nothing pushed.",
      },
      {
        id: "git-agent-commit-show",
        text: "“Show” during a run puts that agent on the Agents page (named “commit”) and its tab disappears when it finishes",
        hint: "The toolbar's right end must not jump as the run changes phase.",
      },
      {
        id: "git-agent-commit-blocked",
        text: "The button is disabled with a reason on a clean tree, and on a workspace whose agent profile is not claude-code",
        hint: "Hover for the tooltip: “Nothing to commit” / “…no verified headless mode”.",
      },
      {
        id: "git-agent-commit-refused",
        text: "An agent run that leaves changes behind says so in the banner and quotes what it reported — no “Committed”",
        hint: "Force it: unset user.email in the repo, then run it.",
      },
    ],
  },
  {
    title: "Git tab — sync & branches",
    items: [
      {
        id: "git-fetch",
        text: "Fetch against a real remote streams progress in the op bar and updates ↓/↑ badges",
        hint: "SSH-agent / credential-helper auth works as in your terminal; a prompt-needing remote fails fast with git's message.",
      },
      { id: "git-cancel", text: "Cancel during a slow push/fetch stops it and the banner says “… cancelled”" },
      {
        id: "git-pull-conflict",
        text: "Pull into a conflicting local commit shows the “Merge in progress” banner; Abort merge restores a clean tree",
      },
      { id: "git-publish", text: "A new local branch shows “Publish”; pushing sets its upstream and the label flips to Push" },
      { id: "git-stash-roundtrip", text: "Stash (with untracked) empties the lists; the stash row shows its files; Pop restores everything" },
      { id: "git-remotes", text: "Add remote / remove remote from the sidebar; with two remotes the toolbar shows the remote picker" },
      {
        id: "git-delete-unmerged",
        text: "Deleting an unmerged branch asks again with “Force delete”; a merged branch deletes on the first confirm",
      },
      { id: "git-checkout-dirty", text: "Checkout that would overwrite local changes shows git's refusal verbatim (no auto-stash)" },
    ],
  },
  {
    title: "Git tab — worktrees",
    items: [
      {
        id: "wt-fork",
        text: "Switcher → New worktree…: a new branch + sibling folder is created, the tab switches to it, and an agent session opens there",
        hint: "Default folder is ../<repo>-<branch>; untick “Start agent here” to skip the session.",
      },
      { id: "wt-switch", text: "Switching worktrees changes lists/diff/commit/push targets; the selection survives an app restart" },
      {
        id: "wt-watch",
        text: "Committing inside a linked worktree from a terminal refreshes the tab (the gitdir watcher)",
      },
      {
        id: "wt-merge-back",
        text: "Merge into <root branch> on a fork merges in the root checkout and offers “Remove & delete”; a conflict switches to the root with Abort available",
      },
      { id: "wt-remove-force", text: "Removing a dirty worktree asks again with “Force remove”; “Also delete branch” deletes it" },
      { id: "wt-prune", text: "rm -rf a worktree folder → it shows “(missing)” and Prune clears it" },
    ],
  },
  {
    title: "Git tab — history",
    items: [
      {
        id: "hist-graph",
        text: "All Commits draws the workspace repo with coloured lanes; merges fork and rejoin; HEAD/branch/remote/tag chips sit on the right tips",
      },
      { id: "hist-scope", text: "“Current” narrows to the checked-out branch and the choice survives an app restart" },
      { id: "hist-detail", text: "Clicking a commit shows message, files and a read-only diff; the Unified/Split toggle still applies" },
      { id: "hist-filter", text: "The filter box narrows rows by subject/author/sha and shows “n of m”" },
      { id: "hist-load-more", text: "On a repo with > 300 commits “Load more” appends without losing the selection" },
      {
        id: "hist-actions",
        text: "Right-click: checkout detached, new branch here, copy SHA; cherry-pick a conflicting commit → banner with Abort cherry-pick",
      },
      { id: "hist-reset-hard", text: "Reset → Hard stays disabled until the short SHA is typed; Soft/Mixed behave as labelled" },
    ],
  },
  {
    title: "Git tab — conflicts",
    items: [
      {
        id: "conf-merge-editor",
        text: "A merge conflict opens the 3-pane editor: ours/theirs panes highlight the numbered regions, Result shows the markers with Ours/Theirs/Both buttons",
        hint: "git switch -c x; edit line 2; commit; git switch main; edit line 2 differently; commit; merge x.",
      },
      { id: "conf-resolve-mark", text: "Choosing per block clears its markers; Save then Mark resolved stages the file and jumps to the next conflicted file" },
      { id: "conf-markers-refused", text: "Mark resolved and the row's + are refused while markers remain (banner says so)" },
      { id: "conf-restore", text: "Restore markers brings git's conflict text back after a save or a whole-file choice" },
      { id: "conf-rebase-labels", text: "During a rebase conflict the panes are labelled “<upstream> (upstream)” and “<branch> (rebasing)”" },
      { id: "conf-delete-modify", text: "A delete/modify conflict shows the chooser sentence with Keep file / Delete file" },
      { id: "conf-binary", text: "A binary conflict offers Keep ours / Keep theirs only" },
      { id: "conf-crlf", text: "A CRLF file resolved in the editor is saved back with CRLF and its final newline state" },
      { id: "conf-mergetool", text: "With merge.tool set, Open in <tool> runs git mergetool in a terminal pane and the editor reloads after the tool saves" },
      { id: "conf-continue", text: "The banner counts conflicted files and Continue unlocks at zero" },
    ],
  },
  {
    title: "Search & filter",
    items: [
      {
        id: "search-board",
        text: "Kanban: typing in the board search leaves only matching cards; each column header reads “n / total”",
        hint: "Title, filename, status, label, context and kind all match; every token must hit something.",
      },
      { id: "search-board-nested", text: "Searching a nested task's title keeps its parent plan, showing just that child" },
      {
        id: "search-board-locked",
        text: "While filtered, a card click still opens it but a card drag does nothing; the bar says “filtered: clear to drag cards”",
        hint: "Column drags and the composer keep working; the ✕ on a column is disabled with a tooltip saying why.",
      },
      { id: "search-board-esc", text: "Esc in the box clears it and the whole board comes back" },
      {
        id: "search-orch",
        text: "Orchestration: a query keeps only the rails holding a hit, rings the matching chips and fades the rest",
        hint: "A rail also matches on its own name and its bound worktree path.",
      },
      {
        id: "search-orch-drawer",
        text: "The Unplaced drawer filters to matches, opens every group, and reads “n / total” — both numbers skipping the Done group",
      },
      { id: "search-orch-locked", text: "No step or card drags while the Orchestration search is set; clearing it restores dragging" },
      {
        id: "search-plans",
        text: "Plans: the search filters plans, docs and specs; contexts with no match drop out of the tree",
      },
      {
        id: "search-plans-facets",
        text: "The Status and Rail dropdowns narrow plans only (docs/specs vanish), AND with the text, and Reset clears all three",
        hint: "“On no rail” lists the plans no rail holds. Deleting the filtered rail resets the facet instead of blanking the tree.",
      },
      { id: "search-git-files", text: "Git: filtering Local Changes narrows both lists and the buttons become “Stage n shown”, staging only those" },
      { id: "search-git-refs", text: "Git nav: the ref filter narrows branches/remotes/stashes and force-opens collapsed sections" },
      { id: "search-git-commits", text: "The commit graph's search box behaves like the others (icon, ✕, Esc) and still filters subject/author/sha" },
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
