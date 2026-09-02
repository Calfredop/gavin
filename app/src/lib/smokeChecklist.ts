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
      {
        id: "composer-card",
        text: "“+ Add card” opens the CENTRED composer modal: Enter adds a FILE in that column and stays open, Esc closes, empty adds nothing",
        hint: "The modal sits over the middle of the tab however far the board is scrolled; the Column picker starts on the column that was clicked.",
      },
      {
        id: "composer-shortcut",
        text: "⌘N (Ctrl+N off macOS) opens the same composer from anywhere on the Kanban tab — and inside a context board TAB",
        hint: "With neither on screen (a terminal focused, or another hub tab) ⌘N must reach the terminal untouched. A second ⌘N over an open composer must not reset a half-typed card.",
      },
      {
        id: "composer-column-pick",
        text: "The composer's Column picker files the card into the column it names, not the one that opened it",
      },
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
        id: "kind-compose-task",
        text: "Composer fast path: it opens on the TASK chip (prompt textarea already there) — type a title, Enter → a kind: task .md lands in plans/ with status: <column>, prompt included when one was typed",
        hint: "cat the file — slugged name, task kind, the column's name as status. The chips read task · plan · note, in that order.",
      },
      {
        id: "kind-compose-note",
        text: "Composer note chip (the LAST of the three): the body textarea disappears; the created file is kind: note with no body",
      },
      {
        id: "kind-compose-plan",
        text: "Composer plan chip: body textarea + Rail picker; plan cards show n/m checklist progress",
      },
      {
        id: "compose-body-enter",
        text: "In the task/plan BODY textarea Enter makes a newline (a checklist types normally) and ⌘Enter files the card; the footer hint says so while the caret is there",
        hint: "The title keeps bare Enter. Tab to a picker and ⌘Enter must still file. Back in the title the hint returns to “Enter adds and stays”, and the note chip (no body) always shows the title hint.",
      },
      {
        id: "compose-chord-anywhere",
        text: "⌘Enter files the card with NOTHING focused: click a kind chip, or the modal's own padding, then press it",
        hint: "One card per press, never two — the same chord typed in the title textarea must still file exactly one. Esc with a chip focused must still close.",
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
    title: "Card attachments",
    items: [
      {
        id: "attach-pick-relative",
        text: "Card detail → Attachments → Pick… a file inside the root writes a RELATIVE attachments: line and shows the chip",
        hint: "cat the card file: `attachments: docs/spec.md`, not the absolute path the dialog returned.",
      },
      {
        id: "attach-pick-absolute",
        text: "Picking a file OUTSIDE the root (e.g. on the Desktop) is accepted and stored absolute",
        hint: "That is the common case — a screenshot has no portable relative form.",
      },
      {
        id: "attach-remove",
        text: "The chip's ✕ removes it; taking the last one off removes the whole attachments: line, not just its value",
      },
      {
        id: "attach-chip-opens",
        text: "Clicking a .md/.ts chip opens it in a split file tab; clicking a .png chip hands it to the OS's app",
        hint: "Needs a terminal pane focused to split beside — with none, both fall back to the OS app.",
      },
      {
        id: "attach-broken-chip",
        text: "Moving an attached file away renders the chip as ⚠ and unclickable, with the path in its tooltip",
        hint: "Reopen the card — the host stats on open, not on scan.",
      },
      {
        id: "attach-blocks-run",
        text: "▶ session on a card with a missing attachment refuses by NAME and starts nothing — and the card stays in its column",
        hint: "The status write happens after the gate, so a refused run must not leave the card in In Progress.",
      },
      {
        id: "attach-blocks-step",
        text: "A rail step on that same card stalls with the same reason on its chip instead of launching",
      },
      {
        id: "attach-in-prompt",
        text: "A card whose attachments resolve launches with their ABSOLUTE paths in the prompt, told to be read first",
        hint: "Read the spawned tab's first screen, or ps the command.",
      },
      {
        id: "attach-compose",
        text: "⌘N → + Attach… attaches before the card exists; the filed card carries the line, and the fields clear for the next card",
      },
      {
        id: "attach-board-count",
        text: "The board card shows a paperclip with the count — and keeps showing it for an attachment that has gone missing",
        hint: "Count only, on purpose: the daemon never stats these paths on scan.",
      },
      {
        id: "attach-old-daemon",
        text: "Against a pre-v18 daemon both Pick… buttons are disabled and hovering the SECTION (not the button) states why",
        hint: "A disabled element never fires mouseenter — the reason has to live on a non-disabled ancestor.",
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
      { id: "run-now-composer", text: "Composer task chip + “Run now” creates the card and immediately runs it, and the modal closes behind it" },
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
        id: "run-develop-card",
        text: "Right-click an unbound To Do card → “Develop into a plan…” spawns an agent that INTERVIEWS you instead of building; the card keeps its status and gains no session dot",
        hint: "The card detail modal offers the same button above ▶ Run, and by the same rule. The entry is To Do only — confirm it is absent (in BOTH surfaces) on In Progress, on Done, on a note, and on a card that already has a session. The spawned command starts “Use the gavin-develop skill…”; answer its questions and the card comes back as a checklist or nested children, still in To Do and still unbound, so “Start all” can then run it.",
      },
      {
        id: "run-names-its-tab",
        text: "A launched agent renames its own tab within the first few seconds — short and about the card, not “gavin”",
        hint: "Run two cards at once: both tabs should be tellable apart at a glance. Board Run, Resume and an orchestration launch all carry the instruction.",
      },
      {
        id: "run-rail-spawns-its-page",
        text: "Starting an unbound rail spawns a page named after it, and the rail's agents land there",
        hint: "The page chip reads “page at Start” beforehand and the rail's name afterwards; a new blank shell on that page opens in the rail's checkout, not $HOME. Re-arming it, or pressing Resume, must not make a second page — close the page while it is paused and Resume is the one case that should.",
      },
      {
        id: "run-merge-into",
        text: "“Merge this rail into a branch” on a rail bound to a worktree LANDS that branch on main; “Update from a branch” is the other direction and leaves main where it was",
        hint: "Bind a rail to a fork carrying a commit, drop each tool on a stage in turn and read `git log main` between them — the landing one adds the merge there, the inbound one only moves the fork. The step must run the merge in the ROOT checkout, so watch that the rail's own tab stays on its branch. Then make the root dirty on a file the merge touches: the step has to report git's refusal and leave that WIP alone, never stash or commit it. On a rail with NO worktree it should stop and say the rail has no branch of its own.",
      },
      {
        id: "run-rail-advances-off-tab",
        text: "Start a rail, switch to the page its agent is working on, and stay there — the rail advances to the next step without you going back to the Orchestration tab",
        hint: "The scheduler used to be an $effect inside the Orchestration tab, so a rail only moved while that tab was on screen and then caught up all at once when you returned. Watch the page: the finished step's tab should be joined by the next step's, live. The Kanban tab is a second place to stand.",
      },
      {
        id: "run-step-turn-ended",
        text: "A card step whose agent stops WITHOUT moving its card to Done marks itself “needs you” — the chip rings warning-coloured, the rail header and the Orchestration tab say so too — and the rail keeps running",
        hint: "Start a rail on a card, then in that agent's tab just answer something and let it sit at its prompt without touching the card's status. Within a second the chip should ring amber with a pause glyph, the rail header gain “needs you”, the Orchestration tab a dot, and the sidebar recap a count. The rail must NOT pause and the step must NOT stall — Mark done is still the way past it. Then type something to the agent: every mark clears while it works, and comes back when it stops again.",
      },
      {
        id: "run-step-asking",
        text: "An agent that ASKS a question mid-step marks the same surfaces, with a question glyph rather than a pause one",
        hint: "Any agent prompt that waits for input will do. The tooltip should read “the agent is asking you something”, not the turn-ended wording — and this one is true of a tool step as much as a card step.",
      },
      {
        id: "run-step-turn-ended-notification",
        text: "With gavin in the background, that same stop notifies “<card title> stopped without finishing its card” — NOT “<tab name> finished”",
        hint: "One notification, not two. Needs the workspace's “finished” notification toggle on and the gavin window not frontmost. A step that really does finish (its card reaches Done, or an agent TOOL step's turn ends) keeps the ordinary “finished” wording — check one of those too, or this only proves the rewrite fires.",
      },
      {
        id: "run-drop-on-running-sequence-stage",
        text: "Dropping a card onto the SINGLE-STEP stage a RUNNING rail is currently on forms a sequence group and the drop stays pending — it goes live on its own the moment the running member finishes",
        hint: "Start a rail, then drag a drawer card onto the chip that is running — the stage becomes a two-member sequence group and the new card sits queued, not started, without you touching Pause/Resume. Finish the running member (its card reaches Done, or its tool step's turn ends) and the second starts on its own, with no Play press needed. Check the negatives too: a drop into the gap between stages, onto a stage the rail has not reached, or onto a paused rail, all stay pending.",
      },
      {
        id: "run-drop-on-running-stage",
        text: "Dropping a card onto a RUNNING stage that already holds two or more steps in parallel spawns its agent at once; every other drop still just queues",
        hint: "Start a rail on a stage that already runs two tool steps side by side, then drag a drawer card onto the running chip — the new agent appears at once, without touching Pause/Resume. Check the negatives too: a drop into the gap between stages, onto a stage the rail has not reached, or onto a paused rail, all stay pending.",
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
        id: "run-clear-done-keeps-restarted",
        text: "“Clear done steps” leaves behind every step the rail still has to run — including one restarted over a card that is still sitting in Done",
        hint: "Run a rail to the end so every card sits in Done, then press Reset run state: the broom must go flat and its tooltip read “This rail has no done steps”, because every step is queued to run again. A stalled step is the same — move its card to Done by hand and it still stays on the rail, since Retry would run it. The fallback still has to work the other way round: on a rail that has NEVER run, moving one of its cards to Done by hand takes that step alone off.",
      },
      {
        id: "skill-updated",
        text: "Re-run “Set up agent integration”: SKILL.md teaches name-your-tab-first, kinds, nesting, promotion, tick-when-done; gavin-orchestrate, gavin-resume and gavin-develop land beside it",
      },
    ],
  },
  {
    title: "Orchestration groups",
    items: [
      {
        id: "group-form-sequence",
        text: "Dropping a card onto another forms a group whose header says “sequence”, with both cards stacked in drop order",
        hint: "Dropping into the gap ABOVE or BELOW a stage still makes a separate stage — only the middle band groups.",
      },
      {
        id: "group-reorder-member",
        text: "Dragging a member onto the top half of the other member swaps their order inside the group",
      },
      {
        id: "group-toggle-parallel",
        text: "The header's parallel button re-lays the members side by side, and the conflicts panel reports the stage again",
        hint: "A sequence group is deliberately NOT a same-worktree conflict; flipping to parallel brings the badge back.",
      },
      {
        id: "group-rename",
        text: "Clicking the group's name edits it; clearing it falls back to “stage N”",
      },
      {
        id: "group-drag-whole",
        text: "Dragging the group's grip moves every member together, to another position and to another rail",
      },
      {
        id: "group-runs-in-order",
        text: "Starting a rail on a sequence group launches ONE member; the next launches only when the first finishes",
        hint: "Two tool steps (e.g. Commit then Push) make this visible without waiting on a card.",
      },
      {
        id: "group-ungroup",
        text: "⋯ → Ungroup leaves one stage per member, in order, with the name gone",
      },
      {
        id: "group-band-sequence",
        text: "A sequence group's header sits inside the same dashed band a parallel one does — the toggle carries the mode, not the band",
        hint: "The band used to mean “these run at once”; check that a human who still reads it that way isn't misled by a sequence group.",
      },
      {
        id: "group-drawer-groups-section",
        text: "The drawer's Groups section sits above Tools, lists every saved template with its scope, and its rows drag onto a rail the same way a card does",
        hint: "Needs at least one saved template first — save one from a group's ⋯ menu if the section is empty.",
      },
      {
        id: "group-save-template-form",
        text: "A lone, single-step stage shows no ⋯ menu at all; once it holds two or more members, ⋯ → Save as template… appears, opening a form with the This workspace / All workspaces choice",
      },
      {
        id: "group-save-template",
        text: "⋯ → Save as template… on a group of tool steps offers This workspace / All workspaces and the template appears in the drawer's Groups section",
      },
      {
        id: "group-template-mixed",
        text: "Saving a group that also holds CARDS says how many card steps it is not saving, and why",
      },
      {
        id: "group-template-place",
        text: "Dragging a template into a gap places it as a named group; dropping it onto an existing group merges its members at the drop slot",
      },
      {
        id: "group-tool-library-groups-tab",
        text: "The tool library has its own Groups tab, next to its Tools tab — separate from the drawer's inline Groups section — where a template's full row of controls lives",
        hint: "This is the surface, not the actions — the next item exercises rename/re-scope/delete there.",
      },
      {
        id: "group-template-manage",
        text: "Tool library → Groups tab renames, re-scopes and deletes a template; a global one is visible from a second workspace",
      },
      {
        id: "group-gate-old-daemon",
        text: "Against a pre-v15 daemon the group header controls are inert and their tooltip says which daemon version they need; the drawer's Groups rows are inert too but stay silent on hover — the same as the Tools rows beside them",
        hint: "The trap this guards: a v14 daemon accepts a sequential group and hands it back parallel.",
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
      {
        id: "edit-no-self-conflict",
        text: "Type several lines at a natural pace, pausing over a second between them — NO conflict banner ever appears",
        hint:
          "The false alarm this rules out: autosave writes, the watcher reports that write 500ms " +
          "later, and the buffer has moved on by then. Nothing but this editor may touch the file " +
          "during the pass.",
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
      {
        id: "prd-pick",
        text: "The PRD tab's Pick… points the tab at another markdown file in the repo, and the strip shows the new path",
        hint: "Make a docs/PRD.md first. The Home tile's excerpt and gavin_read_prd must follow it too.",
      },
      {
        id: "prd-pick-outside",
        text: "Picking a file outside the root is refused inline, and the tab keeps editing the old one",
      },
      {
        id: "agent-file-pick",
        text: "The agent-file tab's Pick… points it at an existing CLAUDE.md/AGENTS.md without offering to move anything",
        hint: "A pick from a subfolder is refused — the CLI only reads this file from the root.",
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
        text: "Orchestration: “Unplaced (n)” counts only cards still waiting — a Done card stays listed in the drawer’s collapsed group but is out of the number AND out of + Add step, and an archived card is in none of the three",
        hint: "Archive a card sitting in the drawer and its row goes. Set one to Done and the row moves to the Done group while the header drops by one — then open + Add step on any rail: the Done card is not in the Cards list, and a nested task under that Done parent is gone too. With every remaining card finished the list reads “Every card left to place is finished.” and Generate with agent… goes inert.",
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
      {
        id: "home-orchestration",
        text: "The Orchestration panel lists every rail with its state and stage progress; starting a rail flips it to running there without leaving Home",
        hint: "The conflict badge must show the same count the tab's conflicts box does — both read detectConflicts.",
      },
      { id: "home-tiles", text: "Each of the six tiles navigates to its tab" },
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
      {
        id: "set-prd-path",
        text: "Settings' PRD file row writes a top-level prd = in config.toml, and the PRD tab follows it",
        hint: "Clearing the box removes the key entirely and puts the tab back on .gavin-root/PRD.md.",
      },
      {
        id: "set-prd-integration",
        text: "After repointing the PRD, “Set up / update” rewrites the CLAUDE.md gavin block and the skill to name the new path",
      },
      { id: "set-command", text: "Editing the command writes .gavin-root/config.toml and the next Start uses it" },
      {
        id: "set-model",
        text: "Picking a Model writes [agent] model, and the row's hint shows the launch line it produces",
        hint: "Custom… reveals a text box; choosing the first row again removes the key and the hint disappears.",
      },
      {
        id: "set-model-launch",
        text: "A workspace Model set to Custom shows up in the next agent launch's command line",
        hint: "Run a card; the terminal's first line should read `claude --model <what you typed>`.",
      },
      {
        id: "global-settings-modal",
        text: "The sidebar footer's Settings opens the global panel, and its Theme control still flips the theme",
        hint: "The footer no longer has a theme toggle of its own — the panel's is the only one.",
      },
      {
        id: "global-settings-inherit",
        text: "A global default for Claude Code makes a workspace with no model of its own read “Default (…)”",
        hint: "Set one in the panel, then look at that workspace's Settings ▸ Model row.",
      },
      {
        id: "set-font-size-app",
        text: "The global panel's Terminal ▸ Font size resizes every open terminal as you pick, and the program inside reflows to the new size",
        hint: "Watch a full-screen TUI (top, or an agent): a wrong reflow means the daemon never heard the new cols/rows.",
      },
      {
        id: "set-font-size-workspace",
        text: "A workspace's own Font size overrides the app-wide one for its terminals only; another workspace's stay put",
        hint: "Its first row reads “Default (n)” with n = the app-wide size — picking that row again clears the override.",
      },
      {
        id: "set-font-size-persists",
        text: "Both sizes survive an app restart, and a terminal restored from the daemon comes back at the chosen size",
      },
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
      {
        id: "set-close-confirm-on",
        text: "“Close confirm” is ticked on a fresh workspace, and closing any tab asks first — ✕, ⌘W, and the tab menu's Close alike",
        hint: "The last tab in a pane gets the stronger “the pane will close too” wording.",
      },
      {
        id: "set-close-confirm-batch",
        text: "“Close Others” asks ONCE for the whole batch, counting the sessions it ends — not once per tab",
      },
      {
        id: "set-close-confirm-off",
        text: "Unticking it closes tabs straight away, including the last tab in a pane; the setting survives a restart",
        hint: "Per workspace: another workspace's tabs still ask.",
      },
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
        id: "wiz-no-flash",
        text: "On a fully set-up workspace, entering the Home tab never shows “Finish setting up this workspace”, not even for an instant",
        hint: "Switch away and back a few times, then relaunch the app onto that Home tab. The panel remounts each visit and re-reads the PRD and instructions file, and a cold start reaches it before the tree watcher has pushed anything; the banner must wait for both rather than assume the worst.",
      },
      {
        id: "wiz-opens-settled",
        text: "Reopening the wizard on a part-finished workspace lands on the genuinely first unfinished step, with no earlier step shown on the way",
        hint: "Finish Agent + Integration + PRD by hand, then open the wizard: it must appear already on Launch.",
      },
      {
        id: "wiz-derived",
        text: "Doing a step by hand (bind a root, run Set up integration in Settings) marks it done without visiting the wizard",
        hint: "Progress is derived from disk, never stored — that's the property this checks.",
      },
      {
        id: "wiz-agent-file-pick",
        text: "The Agent step's Instructions row Pick… points the workspace at an existing CLAUDE.md, and Integration then merges the gavin block into THAT file",
        hint: "The reason the row sits on step 1: pick after Integration ran and the repo ends up with two instructions files.",
      },
      {
        id: "wiz-prd-pick",
        text: "The PRD step's File row Pick… points the workspace at an existing docs/PRD.md and says so",
        hint: "Make a docs/PRD.md with real prose first. Picking a file outside the root shows an inline error and changes nothing.",
      },
      {
        id: "wiz-prd-pick-integration",
        text: "Picking a PRD after Integration ran rewrites the CLAUDE.md gavin block to name the new path, and the note says it did",
      },
      {
        id: "wiz-prd-authored",
        text: "With an already-written PRD picked, the three section fields and “Ask the agent” are gone — the step says the document is already written",
        hint: "The fields have no placeholder to replace there, so offering them would be a form that cannot act.",
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
      { id: "wiz-unfiled", text: "The Scratchpad workspace never offers the wizard" },
    ],
  },
  {
    title: "Context boards",
    items: [
      { id: "board-icon", text: "cd into a .gavin context → kanban icon appears on the pane tab bar" },
      { id: "board-tab", text: "Clicking it opens a “<context> · board” tab for that context" },
      { id: "board-persists", text: "The board tab survives an app restart" },
      { id: "board-missing", text: "Deleting the context folder shows “This context no longer exists”" },
      {
        id: "board-tab-survives-hot-reload",
        text: "With a board tab open, touch app/src/routes/+page.svelte — the tab is still a board afterwards, not a black terminal, and no “unknown session” strip appears",
        hint: "That edit re-runs bootstrap() while layoutState's store keeps running, so the layout tree survives while the tab maps are re-seeded from Rust underneath it. Dev only: the bundled app runs bootstrap once per launch.",
      },
      {
        id: "board-page-scoped",
        text: "The board shows only the cards bound to THIS page: its title reads “· N cards on this page”, and a context card on no rail and in no tab here is absent",
        hint: "Bound = a card you ran into a tab on this page, OR a card carried by a rail whose page this is. Every card in the context is still on the hub's Kanban tab.",
      },
      {
        id: "board-page-empty",
        text: "On a page with nothing bound, the board says “Nothing is bound to this page yet” and no column offers “+ Add card”",
      },
      {
        id: "board-page-rail-cards",
        text: "Start a rail (it takes a page of its own), open that context's board in that page: every card the rail carries is there, including steps that have never run",
      },
      {
        id: "board-page-run-arrives",
        text: "Run a card from the Kanban tab into a tab on this page → it appears on this page's board; close that tab → it leaves again",
      },
      {
        id: "board-page-compose",
        text: "On a rail-bound page, ⌘N offers no “note” chip and a fixed “Rail” row instead of the picker; the card it makes lands on that rail and STAYS on this board",
      },
      {
        id: "board-page-compose-refused",
        text: "On a page with no rail bound, ⌘N writes nothing and says “No rail is bound to this page…”",
      },
      {
        id: "board-page-drag",
        text: "Drag a card between columns on a page's board → its status changes, and the Kanban tab's order of the cards this board hides is unchanged",
        hint: "The visual slot is translated into the whole column (pageBoard.translateDropIndex) — without that, one drop here renumbers every card the page shows and re-interleaves the rest.",
      },
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
    title: "Sidebar tab rows",
    items: [
      {
        id: "sidebar-row-menu-parity",
        text: "Right-click a tab row inside an expanded page: the menu is the tab bar's own — Close / Close Others / to the Right / to the Left, Pin, Split Right/Down, Rename…, Open Folder in Finder, Copy Path — under a Jump entry",
        hint: "Compare it side by side with a right-click on the same tab in the tab bar. The closes must be greyed out exactly where the tab bar greys them (nothing to the right, only a pinned tab to the left).",
      },
      {
        id: "sidebar-row-menu-kinds",
        text: "A file row says “Reveal in Finder” and offers no Split/Rename; a board row says “Open Folder in Finder” and copies its context folder",
        hint: "Both jump entries read “Jump to Tab”; only a terminal row says “Jump to Session”.",
      },
      {
        id: "sidebar-row-menu-other-page",
        text: "Do all of it on a page you are NOT looking at: Pin reorders that page's tabs while the view stays put; Split spawns a terminal AND brings that page on screen",
        hint: "Try it on another workspace's page too. Pin must not switch workspaces; Split must, since it just started a session you would otherwise never see.",
      },
      {
        id: "sidebar-row-rename",
        text: "Rename… turns the row into an input in place; Enter renames the session (the tab bar agrees at once), Escape leaves it alone",
        hint: "Double-clicking the row's name starts the same rename. A blank name must fall back to the cwd label, not stick as empty.",
      },
    ],
  },
  {
    title: "Title bar",
    items: [
      {
        id: "bar-pane-controls-terminal",
        text: "On a terminal page the bar shows Split Right, Split Down and Close Pane, and all three act on the focused pane",
      },
      {
        id: "bar-pane-controls-hub",
        text: "Switching to any hub tab (Home, Kanban, Git…) takes those three away; going back to the terminal brings them back",
        hint: "They address the focused pane of the active page, which a hub tab keeps but never shows — clicking Split there used to spawn a session into a page nowhere on screen. ⌘D already refused from a hub tab.",
      },
      {
        id: "bar-pane-controls-app-hub",
        text: "Opening the app hub takes them away too, even though the workspace under it was on a terminal page",
      },
      {
        id: "bar-new-page-menu",
        text: "“New page” stays put on every tab; clicking it drops a menu of the presets — Single, Side by Side, 2×2 Grid",
        hint: "The menu is the app's one context-menu layer, so Escape, a click elsewhere and the window losing focus all close it, and a second click on the button closes it rather than reopening it.",
      },
      {
        id: "bar-new-page-lands",
        text: "Picking a preset adds a page with that layout to the current workspace AND brings it on screen — do it from the Kanban tab and from the app hub as well, not only from a terminal",
        hint: "Sessions start in the workspace's bound root, and the page is named after the count it already had (Page 3, Page 4…).",
      },
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
    title: "Terminal restore",
    items: [
      {
        id: "restore-agent-restart",
        text: "With a coding agent running in a tab, quit and relaunch the app: the agent's box, banner and prompt come back whole, not as a half-drawn frame",
        hint: "This is the bug. The daemon now sends its own model of the screen instead of replaying a tail of the raw PTY bytes — a tail of an agent's output is repaint DELTAS with no frame under them.",
      },
      {
        id: "restore-agent-hotreload",
        text: "Under `npm run tauri dev`, edit any frontend file so the webview hot reloads: every terminal — tab AND hub — keeps its screen, not just repaints it",
        hint: "Hot reload used to hand every pane a brand-new blank Terminal, because Vite re-executes terminalRegistry.ts for an edit anywhere in its dependency cone. The registry now rides import.meta.hot.data, so the same Terminal survives. Blank = it stopped surviving; a visible repaint flicker = it is only being rescued by the snapshot.",
      },
      {
        id: "restore-hotreload-keeps-scrollback",
        text: "Scroll up in a shell tab, then hot reload: the scrollback above the screen is still there, and the terminal's colours still match the app's theme",
        hint: "Both are things a snapshot repaint cannot give back — the daemon sends 500 rows, and a fresh registry starts at the dark theme regardless of what the app is using. Either one wrong means the terminal was rebuilt rather than adopted.",
      },
      {
        id: "restore-shell-history",
        text: "In a plain shell tab, scroll up after a restart: the output above the current screen is still there",
        hint: "The screen model keeps 500 rows of scrollback and the snapshot prints them above the restored screen. Gone entirely = the history half regressed.",
      },
      {
        id: "restore-no-duplicate-notification",
        text: "Hot reload while an agent is waiting on you: NO duplicate “waiting for input” notification fires",
        hint: "Exactly why the repaint is Request::Snapshot and not a second Attach — Attach re-sends the status baseline, and waiting_for_input notifies unconditionally.",
      },
      {
        id: "restore-arrow-keys",
        text: "After a restart, arrow keys still work inside a restored agent/TUI session (history recall, menu navigation)",
        hint: "The snapshot re-establishes application-cursor mode, which decides whether an arrow sends \\eOA or \\e[A. Wrong keys = input_mode_formatted() stopped riding along.",
      },
      {
        id: "restore-resize-then-restart",
        text: "Resize the window, then restart: the restored screen fits the new width with no wrapped or truncated rows",
        hint: "The parser follows the PTY through ResizeSession; a snapshot rendered at a stale size shows up as broken box-drawing.",
      },
    ],
  },
  {
    title: "An interrupted run",
    items: [
      {
        id: "interrupted-no-second-agent",
        text: "Run a card from the board, wait until the agent is clearly working, then Settings → Restart daemon: the tab comes back as a PLAIN SHELL at the same folder — not the agent starting the same prompt over",
        hint: "This is the bug. recover() used to re-run record.command, which for every agent gavin launches is the entire prompt — a second from-scratch attempt in a checkout that already carries the first one's edits.",
      },
      {
        id: "interrupted-confirm-copy",
        text: "The Restart-daemon confirmation says agents are “stopped, and not restarted”, and names resuming",
        hint: "Against a daemon older than v20 it says the opposite instead, because that daemon really will re-run every command (restartConfirmLines).",
      },
      {
        id: "interrupted-tab-badge",
        text: "That tab's ↻ badge is AMBER, and its tooltip says the agent was stopped and not restarted",
        hint: "Green ↻ = merely restored (a plain shell, which is all it ever meant). A plain terminal tab open at the same time must still show the green one.",
      },
      {
        id: "interrupted-badge-dismisses",
        text: "Typing in that tab dismisses the amber badge — but the card it was running still reads as interrupted",
        hint: "The badge is a note about the SCREEN and always cleared on the first keystroke. The interruption is a fact about the RUN and does not stop being true because someone typed.",
      },
      {
        id: "interrupted-board-card",
        text: "The card's dot on the board is a hollow amber ring; clicking it OPENS THE CARD rather than jumping into the shell",
        hint: "The bare shell carries the original session id, so every “is this card busy?” check used to say yes.",
      },
      {
        id: "interrupted-card-modal",
        text: "The card detail shows “interrupted”, explains what happened, and offers “Resume this card” beside Jump (disabled) and Re-launch",
        hint: "Resume composes the gavin-resume prompt — find the work already done, then add to it. Re-launch would replay the original command from the beginning.",
      },
      {
        id: "interrupted-card-menu",
        text: "Right-clicking that card offers “Resume — the agent was interrupted”, and neither Jump nor Re-launch",
      },
      {
        id: "interrupted-resume-relinks",
        text: "Pressing Resume spawns a new session, binds the card to it, and the amber dot goes back to a live one",
        hint: "The card's STATUS must not move on the board — that is the human's record.",
      },
      {
        id: "interrupted-rail-pauses",
        text: "With a rail running a step, restart the daemon: the step goes stalled with “interrupted — the daemon restarted…” and the rail pauses",
        hint: "Rule 3c. The restored session is back in the layout under its old id, so the scheduler used to see a live session and wait on a shell forever. Play retries the stalled step — one attempt, asked for.",
      },
      {
        id: "interrupted-rail-done-card-wins",
        text: "A step whose card had already reached Done before the restart is marked done, not stalled",
        hint: "Finished work must never be re-run. The card's column outranks the interruption, exactly as it does for a session that exited.",
      },
      {
        id: "interrupted-commit-run",
        text: "Start Commit via agent from the Git tab and restart the daemon mid-run: the tab drops the run silently — no “Committed”, no “failed”, no spinner left going",
        hint: "Its exit code and output died with the daemon, so any verdict would be invented. The refresh afterwards shows whatever commits it did make.",
      },
      {
        id: "interrupted-plain-shell-unchanged",
        text: "A plain terminal tab (no command) restarts exactly as it always did: same folder, green ↻, nothing calling it interrupted",
      },
      {
        id: "interrupted-cwd-followed",
        text: "cd into a subfolder in a tab, then restart the daemon: the tab comes back in THAT subfolder, not at the workspace root",
        hint: "recover() spawned in workspace_path while create_session spawned in cwd; the app passes the same value for both, so this was only ever right by coincidence.",
      },
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
        id: "git-changes-divider",
        text: "Drag the divider between Unstaged and Staged: the split holds while the lists refresh, survives an app restart, and a double-click evens it out again",
        hint: "Release the pointer outside the column too -- WKWebView drops pointerup when the row under the cursor is replaced by a refresh.",
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
        id: "git-amend-count",
        text: "Ticking Amend keeps the staged count on the button — “Amend (N)”, not bare “Amend”",
        hint: "Stage two files, tick Amend: the button must read Amend (2). The count is what reveals files another session left staged.",
      },
      {
        id: "git-amend-pushed-warn",
        text: "Amending a commit already on the remote shows the “rewrites pushed history” warning, and still allows it",
        hint: "On a branch with ahead=0 vs its upstream, tick Amend: the warning names the upstream. Commit one local commit first and it must disappear.",
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
      {
        id: "git-agent-commit-survives-reload",
        text: "Reloading the window mid-run comes back still saying “Committing…”, and the run's own verdict still lands",
        hint: "Start it on a big tree, then ⌘R. The button must not be back to “Commit via agent” — that offers a second agent on the same tree.",
      },
      {
        id: "git-agent-commit-sidebar",
        text: "The sidebar's workspace git chip spins while a run is going, and its tooltip leads with “an agent is committing”",
        hint: "Visible from any hub tab, including a workspace with no repo counted yet.",
      },
      {
        id: "git-chip-survives-reload",
        text: "The sidebar's workspace git chip is still there after ⌘R — repo count, dirty dot and ↑/↓ all back",
        hint: "The chip's numbers only ever arrived as a change-only push baselined on the app's ONE Attach, so before the read-back seed a reload emptied it and nothing refilled it until the repo itself changed. Check the page rows' branch lines and the pane's git dot in the same pass.",
      },
      {
        id: "git-agent-commit-hub-tab",
        text: "The hub's own “Git” tab spins in place of its branch icon while a run is going — visible from Kanban, PRD, any tab",
        hint: "The tab row must not shift as the spinner replaces the icon; no other hub tab reacts.",
      },
      {
        id: "git-agent-commit-notified",
        text: "A run that finishes while you are on another tab (or another app) raises an OS notification naming the workspace and what it did",
        hint: "Leave the Git tab for Kanban and wait. Staying on the Git tab is the only case that must be silent; unticking Settings' “finishes working” silences it everywhere.",
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
        id: "filter-board-context",
        text: "Kanban: the context dropdown reads “All contexts” first, then every context by its path under the root; picking one leaves only its cards — a context nested under it included",
        hint: "“All contexts” IS the root: every context is a subfolder of it, so the root and “all cards” are one answer. A context outside the workspace reads “<name> (outside)”.",
      },
      {
        id: "filter-board-kind",
        text: "The kind dropdown (Plans / Tasks / Notes) narrows to that kind; picking Tasks keeps a plan card that holds a nested task, showing just that child",
      },
      {
        id: "filter-board-rail",
        text: "The rail dropdown lists every rail plus “On no rail”; picking a rail leaves only the cards it carries, and “On no rail” only the cards no rail holds",
      },
      {
        id: "filter-board-compose",
        text: "The three facets AND with each other and with the search; the count beside them reads “n / total” and Reset clears all four at once",
      },
      {
        id: "filter-board-drag",
        text: "With a facet set (search empty), drag a card between columns → its status changes and the cards the filter hides keep their order on the unfiltered board",
        hint: "The visual slot is translated into the whole column (pageBoard.dropAgainstWholeBoard) — without that, one drop renumbers only the cards the filter left showing.",
      },
      {
        id: "filter-board-archive",
        text: "The archive obeys the facets too: its badge count and its grid narrow with the board, and “+ Add card” or ⌘N clears every filter so the new card is visible where it lands",
      },
      {
        id: "filter-board-column-guard",
        text: "A column that lost cards to a facet reads “3 / 11” in its header, and its ✕ and “Archive all” go disabled saying to clear the board's search and filters first",
        hint: "The guard is hiddenCount, and it counts BOTH lenses: a column saying 3 while holding 11 would otherwise offer to clear or delete the 8 the human cannot see.",
      },
      {
        id: "filter-board-prune",
        text: "Delete the rail a facet is filtering on → the dropdown falls back to “Any rail” and the board fills in, rather than staying blank",
        hint: "Only once the orchestration has actually loaded: an unloaded plan must read as “not known yet”, never as “that rail is gone”.",
      },
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
  {
    title: "App hub",
    items: [
      {
        id: "hub-row-opens",
        text: "The pinned “Gavin” row above Workspaces takes over the main pane and stays highlighted while it is showing",
        hint: "It must work with a workspace open, not only from an empty one — gavin has no “nothing open” state.",
      },
      {
        id: "hub-recents-order",
        text: "Switching between two workspaces and reopening the hub puts the one you just left at the top",
        hint: "A workspace never switched to since this build shipped sorts after every stamped one, in sidebar order.",
      },
      {
        id: "hub-recap-agrees",
        text: "A hub row's “n running · n pages” matches what the sidebar's own rows say for the same workspace",
      },
      {
        id: "hub-row-switches",
        text: "Clicking a hub row switches to that workspace and closes the hub; so does clicking any page or tab in the sidebar",
      },
      {
        id: "hub-new-workspace",
        text: "“+ New workspace…” names it, then reaches the setup modal and Continue → the wizard — the same path the sidebar's + takes",
        hint: "The modal must survive the hub closing: it is mounted app-level, not inside the hub.",
      },
      {
        id: "hub-links",
        text: "The footer opens the repo and the issues page in the real browser, and shows no website link",
        hint: "The website row is held back until APP_LINKS has a url for it — no dead link ships.",
      },
      {
        id: "hub-not-persisted",
        text: "Quitting with the hub open and relaunching lands back in the workspace, not on the hub",
      },
      {
        id: "hub-scratchpad-renamed",
        text: "The pinned workspace reads “Scratchpad”, keeps its pages, and appears in the hub's recents like any other",
        hint: "Launch against an existing config.json — the id stays __unfiled__, so nothing may be orphaned by the rename.",
      },
    ],
  },
  {
    // Everything here removes real files or depends on the OS Trash, so
    // none of it is reachable from a unit test. Run the whole section on
    // a SCRATCH repo you are willing to lose.
    title: "Removing a workspace",
    items: [
      {
        id: "delete-x-keeps-everything",
        text: "The sidebar X warns that nothing on disk is deleted, and afterwards .gavin-root/ is still there and the board comes back on re-add",
        hint: "The X used to delete the board silently. Re-adding the folder is the next item — do them together.",
      },
      {
        id: "delete-reclaim-restores",
        text: "Re-adding the removed folder to a NEW empty workspace offers Restore, and Restore brings back the old columns and rails",
        hint: "The rows are keyed by the workspace's uuid — “the board is back” is the only proof the re-key landed.",
      },
      {
        id: "delete-reclaim-start-fresh",
        text: "Choosing Start fresh binds normally, and picking the same folder again does not ask a second time",
      },
      {
        id: "delete-disabled-explains-itself",
        text: "On a workspace with no root, Settings → Danger zone → Delete workspace… is disabled and hovering it says why",
        hint: "A disabled element fires no mouseenter — the reason has to come from the row around it.",
      },
      {
        id: "delete-wizard-walks",
        text: "The wizard walks one screen per category found, Back works from every screen, and a category the scan found nothing for is skipped entirely",
        hint: "Delete .claude/skills/gavin* by hand first — the skills screen should then not appear at all.",
      },
      {
        id: "delete-outside-context-unticked",
        text: "A context registered from outside the root appears under a warning and starts unticked",
        hint: "Add one with the Plans tab's “Add outside context…” before starting.",
      },
      {
        id: "delete-confirm-gated",
        text: "Delete stays disabled until the workspace's name is typed exactly, and the summary lists every path, edit, row group and session",
      },
      {
        id: "delete-declined-survives",
        text: "A category answered No is still on disk afterwards, byte for byte",
        hint: "Decline the instructions block: CLAUDE.md must still hold <!-- gavin:start -->.",
      },
      {
        id: "delete-trash-holds-the-files",
        text: "The trashed folders are actually in the Trash and can be dragged back out",
        hint: "This is the whole reason it is not rm — check the Finder, not just that the folder is gone.",
      },
      {
        id: "delete-shared-files-edited",
        text: ".mcp.json keeps its other servers and CLAUDE.md keeps your own prose — both files still exist",
      },
      {
        id: "delete-leaves-no-tombstone",
        text: "After a delete, re-adding the same folder does NOT offer to restore anything",
        hint: "The opposite of the X: a delete means it, so no record is kept.",
      },
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
