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
        text: "That banner sits above the tabs and offers no picker — only “Open settings”, which opens the workspace's settings",
      },
      {
        id: "root-banner-quiet",
        text: "A rooted, healthy workspace hub shows no folder bar at all — the path is stated only in Settings",
      },
      {
        id: "root-init",
        text: "Settings → Set root… → Initialize scaffolds .gavin-root (PRD, config, plans/docs/specs)",
      },
      { id: "root-persists", text: "Settings' root chip survives an app restart" },
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
        text: "“+ Add card” opens the CENTRED composer modal: Enter adds a FILE in that column and stays open, Esc closes an UNTOUCHED one, empty adds nothing",
        hint: "The modal sits over the middle of the tab however far the board is scrolled; the Column picker starts on the column that was clicked. An untouched composer still closes on the first gesture — no confirm.",
      },
      {
        id: "composer-discard-confirm",
        text: "Type a title, click the backdrop → “Discard this card?”; Cancel keeps every field exactly as typed, Discard closes the composer",
        hint: "Nothing is written until the card is filed and the composer reopens empty, so the backdrop used to destroy a half-written prompt silently. Check the fields really survive Cancel — title, body, kind chip, column, rail and attachments.",
      },
      {
        id: "composer-discard-routes",
        text: "Escape and the Cancel button ask the same question — and so does “Add card” with an empty title but a typed prompt or an attachment",
        hint: "Every way out of the composer is measured the same way. A prompt or an attachment with no title counts as content on its own.",
      },
      {
        id: "composer-discard-keys",
        text: "With the question up, Escape answers only it (the composer stays, still typed) and Enter / ⌘Enter file nothing",
        hint: "Both modals listen at the window, and focus is still in the title field behind the confirm — so an unguarded Enter would file the very card being asked about.",
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
      {
        id: "composer-last-position",
        text: "A card the composer files lands at the BOTTOM of its column, whatever its title starts with — file three in a row and they stack up in the order they were typed",
        hint: "Try a title starting with “a” into a column whose cards start later in the alphabet. A new card carries no order:, and unordered cards sort by file name — so without the placement write it appears mid-column. The first card filed into a never-dragged column materializes order: for that whole block, exactly as the first drag there does.",
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
        id: "kind-detail-child-open",
        text: "Card detail → Tasks: clicking a row swaps the modal onto THAT task — its own title, prompt, attachments and session block, not the plan's",
        hint: "Free-standing children (the ones wearing a status) are in the same list and open the same way. The Un-parent button beside the row must still only detach — it never navigates.",
      },
      {
        id: "kind-detail-part-of",
        text: "The task's “Part of” row is a link back to the plan: one click each way, and every card the modal lands on starts scrolled to the TOP",
        hint: "Open a long plan, scroll down to Tasks, click a short child — you should be looking at the child's header, not at empty space below it. A card whose parent file is missing keeps the plain ⚠ <file> (not found) text with nothing to click.",
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
        text: "▶ new session on a card with a missing attachment refuses by NAME and starts nothing — and the card stays in its column",
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
      {
        id: "nest-not-in-unplaced",
        text: "A nested child is absent from the Orchestration tab's Unplaced drawer and from “+ Add step”; its plan's row wears a “+N” instead",
        hint: "A nested child has no card of its own — the plan carries it, on the board and on a rail alike. Check the plan's row in BOTH surfaces shows the count, and that the drawer's header total dropped by the number of children (they are no longer counted as work left to place). Then drag the plan onto a rail: the whole family leaves the drawer at once — expand its step and the children are drawn inside the card, which is where they went. A child given a status: of its own reappears in both lists immediately.",
      },
      {
        id: "nest-with-parent-conflict",
        text: "Right-click a nested child → “Send to rail” while its plan is on a rail too: the Conflicts box gets a “nested inside” row badging BOTH steps",
        hint: "The only route to it, since neither the drawer nor the picker offers a nested child. Hovering the row lights both chips with the same number. Taking either step off clears it; so does finishing the child's step.",
      },
    ],
  },
  {
    title: "Run & bindings",
    items: [
      {
        id: "session-actions-own-row",
        text: "On an unbound card, the detail modal stacks “Develop into a plan…” and “▶ Run …” one per row, each still only as wide as its own label",
        hint: "Both labels are sentences, so side by side they wrapped mid-label. Check a plan and a task (the Run label differs), and a card with no Develop button — the lone Run button must not stretch across the modal.",
      },
      {
        id: "develop-jumps-to-tab",
        text: "“Develop into a plan…” lands you IN the spawned agent's tab (terminal view, Agents page) rather than leaving you on the board",
        hint: "From both surfaces that offer it — the card menu and the detail modal. Develop writes no status and binds no session, so the board it was started from shows nothing at all afterwards; the agent's first move is a question, and the jump is what puts you in front of it. The tab is named after the card until the agent renames itself.",
      },
      {
        id: "run-task",
        text: "Hover pills: blue ▶ new session spawns a dedicated bound agent (Agents page, attached, no focus steal) and sets In Progress",
        hint: "The composed command is agentCommand + the quoted prompt; cwd = the card's context folder.",
      },
      {
        id: "run-plan",
        text: "▶ new session on a plan hands the agent a pointer prompt (read the file, tick items, promote, keep status)",
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
        text: "Green ▶ hub pill pastes the prompt into the RUNNING main agent and jumps Home; disabled (with tooltip) when none runs",
        hint: "No binding/dot for main-agent sends — the card's status is the tracking.",
      },
      {
        id: "claim-agent-start",
        text: "Ask the Home tab's workspace agent to file a card AND start it: the card appears already wearing that session's dot, with no ▶ pill",
        hint: "The agent's own gavin_set_plan_field(\"In Progress\") is the claim. Needs a daemon at v21+ — an older one leaves the card unbound, as before.",
      },
      {
        id: "claim-arrives-live",
        text: "That dot appears while you are LOOKING at the board — no tab switch or refresh needed",
        hint: "The board refetch rides the gavin-tree push the agent's own card write produced (~170ms).",
      },
      {
        id: "claim-backlog-startable",
        text: "A card the same agent files as To Do keeps its ▶ pill and still counts in the column's “Start all”",
        hint: "Only In Progress claims. Filing a backlog must not make it unstartable.",
      },
      {
        id: "claim-no-steal",
        text: "A card already bound to a LIVE spawned agent keeps that dot when a different agent writes In Progress on it",
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
        hint: "The card detail modal offers the same button above ▶ Run, and by the same rule. The entry is To Do only — confirm it is absent (in BOTH surfaces) on In Progress, on Done, on a note, and on a card that already has a session. The spawned command starts “Use the gavin-develop skill…”; answer its questions and the card comes back as a checklist, nested children or just a sharper prompt, still in To Do and still unbound, so “Start all” can then run it.",
      },
      {
        id: "develop-locks-the-card",
        text: "While a card is being developed it wears an accent Agent · developing badge, an accent spine, and both its run pills are dead",
        hint: "Start a develop run and go back to the board without answering the agent. The card face should carry the drafting-compass badge (click it: it lands you back in that agent's tab) and both pills — ▶ new session AND ▶ hub — should be greyed, with the reason in the row's tooltip. Its right-click menu should offer “Developing — jump to its tab” INSTEAD of Run / Run on several agents / Send to workspace agent, and the detail modal should replace those buttons with one “Jump to the develop session”. Answer the agent and let it finish: within a couple of seconds of the tab going idle the badge clears and every control comes back.",
      },
      {
        id: "develop-lock-covers-every-launch",
        text: "Nothing can start work on a card being developed — the column's Start all skips it, and a rail step over it stalls with “the card is being developed”",
        hint: "With one develop run going: the To Do column's “Start all (n unbound)” must both COUNT and start one fewer, leaving the developing card alone. Put the same card on an orchestration rail and start the rail: the step chip stalls with that reason and the rail pauses, rather than launching. Let the develop agent finish, then press the rail's Start again — the step runs, with the card the agent rewrote.",
      },
      {
        id: "develop-lock-survives-a-reload",
        text: "The lock and the badge survive a frontend reload, and a develop run whose tab you close releases its card",
        hint: "The record lives in config.json beside the workspace, so ⌘R (or a restart) must come back with the badge still on the card. Then close the develop agent's tab: the badge clears within a tick and the run pills come back — a card locked by an agent that is gone is the one failure mode worse than no lock at all.",
      },
      {
        id: "run-develop-switches-kind",
        text: "Developing a card that turns out to need steps flips it to kind: plan, and one that does not leaves it kind: task",
        hint: "Develop a card into a checklist: the board card must gain the n/m progress chip and the detail modal a tickable Checklist section — both are drawn for plans only, so a developed card still marked kind: task looks empty however many “- [ ]” lines it holds. Do it again on a genuinely small card and refuse a decomposition: it should stay kind: task with a rewritten body, since the plan prompt never inlines a body and would hand its agent a checklist that is not there. Read the frontmatter of both afterwards — the agent proposes the switch before it writes, so it is also the one thing you can veto in a word.",
      },
      {
        id: "run-names-its-tab",
        text: "A launched agent renames its own tab within the first few seconds — short and about the card, not “gavin”",
        hint: "Run two cards at once: both tabs should be tellable apart at a glance. Board Run, Resume and an orchestration launch all carry the instruction.",
      },
      {
        id: "run-rail-spawns-its-page",
        text: "An unbound rail's FIRST LAUNCH spawns a page named after it, and the agent is that page's only tab — no blank terminal ahead of it",
        hint: "Press Start and watch the sidebar: no page appears until the first step actually launches, and the one that then appears holds exactly one tab, the agent's, opened in the rail's checkout rather than $HOME. This is the fix — the page used to be made at Start, which meant opening an idle shell to have something to put on it, and that shell then sat first in the tab strip forever. Re-arming the rail, or pressing Resume, must not make a second page; close the page mid-run and the next launch makes a fresh one. A rail whose stage holds only a `gavin` action (Start rail) launches no session and so must get no page at all.",
      },
      {
        id: "run-rail-page-at-launch",
        text: "A rail armed WITHOUT Start — its run row written straight to the daemon socket while the workspace is active — still lands its first step on a page named after the rail",
        hint: "Leave the rail unbound, stand on the workspace's active page, and write `SetRailRun { state: \"running\" }` for it to the daemon socket (the way the Grimoria agent did when it found no start tool). The Orchestration tab adopts the row on its next refresh and the step launches: its tab must appear on a NEW page carrying the rail's name, the chip must read that name, and the page you were standing on must gain nothing. Then let the rail advance, press Retry on a stalled step, and Resume one — every launch keeps landing there. Close the page mid-run and the next launch makes a fresh one.",
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
        id: "run-step-decoy-warning",
        text: "A card step launched on a rail with a WORKTREE opens its agent with the “this card lives at \u2026 and nowhere else” paragraph; the same card run from the board (no worktree) does not",
        hint: "Read the agent's first screen, or the command in the Sessions manager. The negative half is the point: a board Run launches in the card's own folder, where there is no second copy, and a warning about a hazard that is not there teaches an agent to skim the framing.",
      },
      {
        id: "run-step-decoy-edit",
        text: "An agent that edits its worktree's OWN copy of the step's card marks the step “needs you” with a file glyph, and the tooltip names the decoy \u2014 within about thirty seconds, whether or not the agent committed it",
        hint: "Start a rail bound to a worktree, then in that agent's tab edit <worktree>/.gavin-root/plans/<the card>.md (moving it into plans/done/ counts) and leave the real card alone. The sweep runs on a 30s clock, so wait one. Commit the edit inside the worktree and the mark must SURVIVE \u2014 that is the whole reason this reads run changes rather than git status. Touch nothing and no mark may ever appear.",
      },
      {
        id: "run-step-stale",
        text: "A step whose agent's turn ended and whose card is still not in Done escalates from the amber “turn ended” mark to a red “stopped for good” one after ten minutes, on the chip, the rail header and the hub's Waiting-on-you list",
        hint: "The same setup as run-step-turn-ended, then leave it. The clock is the session's last status CHANGE, so do not type at the agent while you wait. The hub row's wait column should read “10m” (or “\u226510m” if the app attached after the agent went quiet).",
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
        id: "run-skip-and-proceed",
        text: "“Skip and proceed” on a running or stalled step sends the rail past it — the step reads “skipped” (a struck-through square, no green), the next stage starts, and the agent's own tab is left alone",
        hint: "Sits next to Mark done on both the step card and the chip, and only on a running or stalled step. Do it on a STALLED step for the important half: the rail was paused by that stall, and Skip has to un-pause it and carry on by itself — no Play press. Check the honest half too: the skipped step must NOT go green, must not be swept by “Clear done steps”, and moving its card to Done by hand afterwards must not re-file it as done. On an IDLE rail (never started, or reset) a skip must not start anything.",
      },
      {
        id: "run-clear-done-keeps-restarted",
        text: "“Clear done steps” leaves behind every step the rail still has to run — including one restarted over a card that is still sitting in Done",
        hint: "Run a rail to the end so every card sits in Done, then press Reset run state: the broom must go flat and its tooltip read “This rail has no done steps”, because every step is queued to run again. A stalled step is the same — move its card to Done by hand and it still stays on the rail, since Retry would run it. The fallback still has to work the other way round: on a rail that has NEVER run, moving one of its cards to Done by hand takes that step alone off.",
      },
      {
        id: "run-start-rail-tool",
        text: "A “Start rail” step naming another rail arms that rail the moment the first rail reaches it — and finishes instantly, with no session of its own",
        hint: "Drag Start rail from the drawer onto the END of rail A, open its Sliders and type rail B's name, then start A. When A reaches the step it must go done at once (no tab appears, no terminal opens) and B must start on its own — B's page appears, its first agent launches. Watch it from B's page too: the chain has to fire whether or not the Orchestration tab is on screen.",
      },
      {
        id: "run-start-rail-refuses",
        text: "Start rail refuses, with the reason on the chip, for: a blank name, a name no rail carries, the rail it is on, and a PAUSED rail",
        hint: "Four presses. Each stalls the step and pauses the rail carrying it — hover the chip for the sentence. The paused one is the load-bearing case: pause rail B mid-run, then let A reach the step. It must NOT resume B (that would re-launch whatever stalled it) and must say so. Then check the two shrugs, which are done and NOT stalls: name a rail that is already running, and one whose every step is finished — both leave that rail exactly where it was.",
      },
      {
        id: "run-start-rail-library",
        text: "Start rail reads “Gavin action” in the drawer and the library, with its own ⚡ icon, and the library offers no Duplicate on it",
        hint: "Its params popover previews “Start the rail “<name>”.” rather than a command line, and says nothing is named yet when the field is empty. The library's Built-in section shows “gavin's own” where the other eleven show Duplicate.",
      },
      {
        id: "run-until-loops",
        text: "A “Loop until a check passes” step after an agent step re-runs THAT step when the check fails, with the rail staying running and its header reading “retry 1 of 5”",
        hint: "Add an agent step whose card asks for something that breaks the check (e.g. “add a failing test”), then + Add step → Loop until a check passes, and set its Check command to something that fails (`false`, or the project's test command). Start the rail. The check opens as a VISIBLE shell tab on the rail's page and prints its output. When it exits non-zero the rail must NOT pause and the chips must NOT go red: the check goes back to pending, the agent step re-launches, and the rail header carries the retry badge beside “running”. Set Check to `true` afterwards and the loop must end — the step goes done and the rail completes.",
      },
      {
        id: "run-until-prompt-carries-failure",
        text: "The re-run agent's prompt opens with “The previous attempt failed this check:” and the check's own last lines, then the card's prompt",
        hint: "Read the new tab's first screen. The fenced block is the tail of what the check printed — not a summary, not empty. A shell step in that position (a Bash command tool) is simply re-run instead, with its command line untouched: put one before the check and confirm nothing is pasted in front of it.",
      },
      {
        id: "run-until-budget",
        text: "With Retries set to 1 and a check that never passes, the rail retries exactly once and then STALLS with the check's last output as the reason",
        hint: "Open the until step's Sliders, set Retries to 1. The agent step runs twice in total, then the check stalls, the rail pauses, and hovering the check's chip shows “the check still failed after 1 retry — …”. Press Reset run state and start again: the budget must be fresh, i.e. it retries once more rather than giving up immediately.",
      },
      {
        id: "run-until-library",
        text: "Loop until a check passes reads “Loop until” in the drawer and the library with its own ↻ icon, and the library offers no Duplicate on it",
        hint: "It is in the + Add step picker's Tools list beside the others. Its Sliders show two fields, Check command and Retries. The library's Built-in section shows “gavin's own” where the other eleven show Duplicate.",
      },
      {
        id: "pr-chips-on-a-bound-rail",
        text: "A rail bound to a branch with an open PR shows a read-only chip row under its binding: “#123”, the check tally, and the review state",
        hint: "Bind a rail to a branch that has a pull request (open one with the “Open a pull request” tool if you need to). Within about fifteen seconds the chips appear UNDER the worktree/branch line, not beside the rail name. #123 links out to GitHub in a browser; hovering it says the PR title and “checked just now”. A branch with NO pull request must show no chips at all — not a grey placeholder. Unbind the rail and the row disappears.",
      },
      {
        id: "pr-chips-say-when-gh-cannot-answer",
        text: "With `gh` logged out, the chip row reads “PR unknown” with gh's own first line as its tooltip — and the rail does not stall",
        hint: "`gh auth logout` in a terminal, wait for the next poll. The chip must be amber and say why. `gh auth login` again and it recovers on its own without touching the rail. This is the one case the wait step is deliberately patient about: a rail waiting on CI must survive a sleeping laptop and a dropped VPN.",
      },
      {
        id: "run-await-pr-waits",
        text: "A “Wait for the pull request” step sits `running` with NO session tab while checks are in flight, and marks itself done when they pass",
        hint: "Rail bound to a branch, a step that pushes, then + Add step → Wait for the pull request. Start it. The wait step goes running and the rail's page gets NO new tab — gavin does the waiting itself. The rail header's check chip counts up (“1/3 checks”) as CI reports. When every check passes the step goes done and the rail advances. Nothing merges: the PR is still open on GitHub afterwards.",
      },
      {
        id: "run-await-pr-loops-on-a-failing-check",
        text: "A failing CI check sends the rail BACKWARDS over the step before the wait, with the rail still running and its header reading “retry 1 of 3”",
        hint: "Push something that fails CI. When GitHub reports the failure the rail must NOT pause and the chips must NOT go red-and-stopped: the wait goes back to pending, the previous step re-launches, and the retry badge appears beside “running”. The re-run agent's prompt must open with the failing checks BY NAME and their run URLs — read the new tab's first screen. Set Retries to 1 first and confirm it gives up after one, stalling with “the pull request still was not ready after 1 retry — …”.",
      },
      {
        id: "run-await-pr-refuses-an-unbound-rail",
        text: "A wait step on a rail with no branch stalls at once with “this rail binds no branch, so there is no pull request to wait for”",
        hint: "Unbind the rail (or bind a worktree with no branch) and start it. The step must stall rather than sit running forever — there is no pull request for it to wait on. Pausing a rail mid-wait must also stall the wait step (“the rail stopped while this step was waiting on the pull request”) so the rail stays editable and deletable; pressing Play resumes the wait.",
      },
      {
        id: "run-await-pr-library",
        text: "Wait for the pull request reads “Wait on a pull request” in the drawer and the library with its own pull-request icon, and offers no Duplicate",
        hint: "Its Sliders show two fields, “Wait for (checks / approval)” and Retries, and the preview reads “This step will wait on this rail's pull request…” rather than a command line. Set Wait for to “checks and approval” and confirm the step then holds until the PR is approved — and that a reviewer requesting changes loops the rail back exactly as a failing check does.",
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
        id: "group-drag-label",
        text: "While a group flies, the ghost under the cursor reads that group's own label — its name, or “stage N” — never a bare “Group”",
        hint: "Do both: drag a named group, then an unnamed one and check the ghost's number is the one its header was showing. A generic word tells you nothing about which of four groups you are holding.",
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
        id: "edit-hub-document",
        text: "On a wide window the PRD and CLAUDE.md tabs centre the text in an A4-ish column — Formatted prose and the Edit/Plain editor alike — with the scrollbar at the pane's right edge",
        hint:
          "Narrow the window: the column shrinks with it and never leaves a gap. A file tab and the " +
          "Plans editor are untouched — edge to edge, Formatted still left-aligned under its 900px cap.",
      },
      {
        id: "edit-hub-prose-size",
        text: "Formatted on those two tabs is set smaller than a file tab's Formatted view; Edit keeps the editor's usual size",
      },
      {
        id: "edit-hidden-pane",
        text: "Open a file tab, switch to a sibling tab and back — the editor is full height, not collapsed",
      },
      {
        id: "md-bar-shows",
        text: "A markdown file in Edit shows a formatting bar at the left of the mode strip; Plain and Formatted hide it, and a .rs file never has one",
        hint: "Narrow the pane: the bar wraps and the Formatted/Plain/Edit switch drops to a second row — nothing clips.",
      },
      {
        id: "md-bar-inline",
        text: "Select a word, click B → **word** with the word still selected; click B again → the stars go. With the caret inside a word the word is wrapped; on a space, an empty pair with the caret between",
      },
      {
        id: "md-bar-blocks",
        text: "Select three lines, click the bullet button → each gets “- ”; the numbered button renumbers them 1. 2. 3.; the same button again strips the marks",
        hint: "Quote adds “> ” to every line; H2 on a line already H2 clears it; the rule and table land on their own lines with a blank above and below.",
      },
      {
        id: "md-bar-chords",
        text: "⌘B / ⌘I / ⌘⇧X / ⌘E / ⌘K toggle bold / italic / strikethrough / code / link from the keyboard, and each button's tooltip names its chord",
        hint: "In Plain mode the chords do nothing to the text. In a .rs file in Edit, ⌘B leaves the source alone.",
      },
      {
        id: "md-bar-focus",
        text: "Clicking a bar button keeps the caret in the editor — typing continues right where the action left it, and the action is one ⌘Z away",
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
        id: "exp-open-in-editor",
        text: "A card's detail modal and its right-click menu both say “Open in card editor”; either lands on the Plans tab with that file selected and its editor already in Edit mode",
        hint: "Was “Open in Plans tab”, which arrived in Formatted mode — one click short of typing. A file picked from the tree still opens Formatted.",
      },
      {
        id: "exp-remember-selection",
        text: "Select a file, switch its editor to Plain, go to Kanban and come back → the same file is selected and still in Plain; a reload keeps it too",
        hint: "The hub view is destroyed on every tab switch; the selection lives in localStorage per workspace, so another workspace's Plans tab remembers its own file.",
      },
      {
        id: "exp-remember-moved",
        text: "With a card selected, drag it to Done on the board and return to Plans → the pane says “Select a file.”, not “This file no longer exists.”",
        hint: "A remembered path is checked against the tree before it is shown; the vanished notice stays for a file deleted while you are looking at it (exp-vanished).",
      },
      {
        id: "exp-new-plan",
        text: "+ → Plans → title → Enter creates the file, selects it, and it appears LAST in To Do on the board (~3s)",
        hint: "The status is written explicitly here, so the file says “To Do” and the card is placed at the end of that column — the same rule the board's own composer follows.",
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
        hint: "Archive a card sitting in the drawer and its row goes. Set one to Done and the row moves to the Done group while the header drops by one — then open + Add step on any rail: the Done card is not in the Cards list, and a nested task under that Done parent is gone too. With every remaining card finished the list reads “Every card left to place is finished.” and Organize with agent… goes inert.",
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
      {
        id: "home-board-panel-size",
        text: "The Board panel is only as tall as its column chips; the PRD excerpt takes the height it used to spend",
        hint: "Add columns until the chips wrap past a third of the side column — the panel caps and the chips scroll rather than pushing the PRD out.",
      },
      {
        id: "home-prd-scrolls",
        text: "The PRD panel scrolls: a PRD longer than the panel can be read on past its last visible line, and never ends mid-sentence with no way on",
        hint: "Wheel over the excerpt. Paragraph breaks must survive — a wall with no blank lines means prdExcerpt went back to stripping them.",
      },
      {
        id: "home-divider-drag",
        text: "The gap between the agent and the PRD/Board/Orchestration column drags: the agent terminal reflows to its new width, and neither side can be dragged away entirely",
        hint: "Drag past both ends. Release outside the window too — WKWebView drops pointerup when the target leaves the DOM, and the buttons===0 bail-out is what catches it.",
      },
      {
        id: "home-divider-persists",
        text: "The dragged split survives leaving the Home tab and an app restart; a double-click on the divider puts it back to the shipped 3:2",
        hint: "The panel remounts on every visit to Home, so a split that only survives the visit is component state that never reached config.json.",
      },
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
        id: "set-sp-row",
        text: "The Agent section ends with a Superpowers row: an Install button only when it is genuinely absent, otherwise the LED and its sentence",
        hint: "The card's rule literally — a button that only shows when there is something to install.",
      },
      {
        id: "set-sp-profile-switch",
        text: "Switching profile re-asks: with Cursor the row explains gavin cannot check and offers the slash command instead of a button",
        hint: "The detector is per profile, so the row must not keep answering for the agent selected a moment ago.",
      },
      {
        id: "set-sp-take-back",
        text: "After “I've installed it”, Settings offers “Take that back”, and using it returns the row to the honest not-installed state",
        hint: "Only Settings offers this; the wizard's own step does not, where “Not now” already covers changing your mind.",
      },
      {
        id: "set-sp-no-root",
        text: "On a workspace with no root bound, the whole Agent section — Superpowers row included — is replaced by the bind-a-root hint",
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
      { id: "wiz-steps", text: "The wizard opens on the first unfinished step and walks Agent → Integration → Superpowers → PRD → Launch" },
      {
        id: "wiz-no-sideways-scroll",
        text: "No step of the wizard scrolls sideways — at a normal window width and with the window narrowed until the step strip wraps",
        hint: "It used to force a 520px minimum inside a 480px panel, so every step scrolled. The wizard now sizes to the panel; the controls shrink and the strip wraps.",
      },
      {
        id: "wiz-prd-pick-big-repo",
        text: "In a LARGE repository (tens of GB, thousands of folders), the PRD step's Pick… shows the picked path within a few seconds — and so does Settings after navigating away and back",
        hint: "Needs the rebuilt daemon. Arming the watcher used to register one FSEvents watch per folder (minutes on a big tree) on the app's streaming connection, so no tree push — and no Attach for a launched agent — got through until it finished.",
      },
      {
        id: "wiz-launch-big-repo",
        text: "In that same large repository, “Start agent →” on the Launch step lands on a Home tab whose terminal shows the agent, not a blank pane",
        hint: "Same cause as the item above: the Attach sat behind the watcher start on the streaming connection.",
      },
      {
        id: "wiz-resume",
        text: "Closing the wizard mid-way leaves the workspace usable; the Home tab offers “n of 5 done — continue”",
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
        text: "With Cursor, “Ask the agent” is absent and the step says why; with Codex, Gemini or opencode it is offered",
        hint: "Cursor is now the only profile with nowhere to put a prompt — opencode has one, it is just a flag (--prompt=) rather than the bare positional.",
      },
      {
        id: "wiz-sp-verified",
        text: "On a Claude Code workspace that already has Superpowers, the step shows a filled green LED and says it is active — with no Install button",
        hint: "Detection runs `claude plugin list --json` with cwd = the root, because `enabled` is answered relative to it. A user-scope install counts from anywhere.",
      },
      {
        id: "wiz-sp-install",
        text: "On a workspace without it, Install runs hidden and the LED turns green without a reload; Show output holds the CLI's own lines",
        hint: "Uninstall first: `claude plugin uninstall superpowers@claude-plugins-official --scope project` in the root. A second Install is a no-op success, not an error.",
      },
      {
        id: "wiz-sp-install-fails",
        text: "With `claude` unreachable, Install shows the failure and opens the output drawer by itself, and the LED stays off",
        hint: "Launch the app from Finder rather than a shell to get the stripped PATH, or point [agent] command at a name that does not exist. The message must name the missing binary.",
      },
      {
        id: "wiz-sp-copy",
        text: "With Cursor or Codex selected, there is no Install button — the step names why gavin cannot check, shows the slash command, and Copy puts it on the clipboard",
      },
      {
        id: "wiz-sp-asserted",
        text: "“I've installed it” turns the LED into a hollow green ring, and the wording says gavin has not confirmed it",
        hint: "Hollow vs filled is the whole point: one is a check, the other is your word. They must not look the same.",
      },
      {
        id: "wiz-sp-not-now",
        text: "“Not now” finishes the step, and the Home banner never asks about Superpowers again for that workspace",
        hint: "Relaunch the app to confirm it stuck — the marker is in the app's config.json, keyed by root path.",
      },
      {
        id: "wiz-sp-machine-local",
        text: "The marker does not travel: a second checkout of the same repo at another path starts with the step unanswered",
        hint: "Keyed by root path on purpose — a repo can reach a machine that has no Superpowers, and an assertion made here must not vouch for it.",
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
      {
        id: "wiz-complete",
        text: "The Home card disappears once Agent, Integration and PRD are done — an unlaunched workspace does not nag",
        hint: "Launch is optional, so it is not part of the condition. Skip it and the card must already be gone.",
      },
      {
        id: "wiz-stop-no-nag",
        text: "Pressing Stop on the Home tab's Main agent panel does NOT bring the setup banner back",
        hint: "Same for the agent exiting on its own — type exit in it. Launch's evidence is a live session, the only step that can un-happen; the banner must not read it.",
      },
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
        id: "board-page-compose-last",
        text: "That card lands at the bottom of the column on THIS board, and the Kanban tab's order of the cards this page hides is unchanged",
        hint: "Same translation the drag path uses (pageBoard.translateDropIndex): the end of what the page shows is a slot in the middle of the whole column, not the end of it.",
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
    // The second profile that gets everything: skills, a seeded card
    // run, and a hidden commit run. Its argv conventions differ from
    // Claude Code's at every one of those points, and argv is precisely
    // what no suite here can exercise -- a wrong flag is green in Node
    // and dead in a terminal.
    title: "opencode profile",
    items: [
      {
        id: "oc-integration-writes",
        text: "On the opencode profile, Integration writes AGENTS.md, the four skills under .opencode/skills/, opencode.json and .opencode/agent/gavin-commit.md — and no .claude/ or .mcp.json appears",
        hint: "Set profile = \"opencode\" in .gavin-root/config.toml first. The wizard's Integration step lists every path it wrote; read that list.",
      },
      {
        id: "oc-card-run-seeded",
        text: "Running a card opens the opencode TUI with the card's prompt ALREADY posted as a user message and the agent working on it",
        hint: "This is the whole bug: before the fix the session died with “Failed to change directory to …”, because the bare positional is a project folder. If you see a directory error, the flag did not survive.",
      },
      {
        id: "oc-skills-load",
        text: "Inside that session the gavin skill is available and the agent follows it (it names its own tab within the first move)",
        hint: "opencode discovers skills at process start, so a session opened BEFORE the write will not see them — start a fresh one.",
      },
      {
        id: "oc-mcp-tools-callable",
        text: "The gavin_* tools work from inside an opencode session — ask it to read the PRD and create a card",
        hint: "opencode namespaces MCP tools by server key, so they appear as gavin_gavin_read_prd. The card landing on the board is the proof.",
      },
      {
        id: "oc-commit-via-agent",
        text: "Git tab → “Commit via agent” on a dirty repo commits in chunks, leaves the tree clean, and ends on its own",
        hint: "The run is hidden and has no way to ask permission: its grant is .opencode/agent/gavin-commit.md. Delete that file and the run should fail loudly rather than hang.",
      },
      {
        id: "oc-cursor-still-blocked",
        text: "Switch the profile to Cursor: the card's ▶ new session pill is disabled and hovering the row says the agent takes no prompt",
        hint: "Hover the ROW, not the greyed pill — a disabled element fires no mouseenter. Same sentence on the card modal, inline.",
      },
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
    title: "Sidebar expansion memory",
    items: [
      {
        id: "sidebar-expansion-survives-reload",
        text: "Expand two workspaces and one page's tab list, reload the window: exactly those rows come back open, and no others",
        hint: "⌘R, or the Restart daemon & retry overlay — the sidebar is unmounted whenever the layout leaves “ready”, which is what used to lose this.",
      },
      {
        id: "sidebar-expansion-collapse-sticks",
        text: "Collapse the ACTIVE workspace, reload: it comes back collapsed",
        hint: "This is the one the first-activation auto-expand used to undo on every launch. A collapse is an answer and must outlive the reload.",
      },
      {
        id: "sidebar-expansion-first-visit-still-opens",
        text: "A workspace you have never expanded still opens itself the first time you switch to it",
        hint: "Remembering must not cost the courtesy. Only a workspace with no answer yet auto-expands — after that, whatever you last chose stands.",
      },
      {
        id: "sidebar-expansion-forgets-what-is-gone",
        text: "Expand a page, close it, relaunch: no ghost row, and the other pages' expansion is untouched",
        hint: "Same for a removed workspace. Entries are pruned against what still exists on every write.",
      },
    ],
  },
  {
    title: "Closing a page's idle tabs",
    items: [
      {
        id: "close-idle-enabled",
        text: "Right-click a page row: “Close Idle Tabs” is greyed out while every session is working or waiting, and live the moment one goes idle",
        hint: "The page row's own recap is the check: greyed exactly when it shows no “N idle”.",
      },
      {
        id: "close-idle-count-agrees",
        text: "The prompt's count is the same number the page row shows as “idle”",
        hint: "A tab that never ran anything counts as idle on both — that is the case most likely to disagree.",
      },
      {
        id: "close-idle-prompt-is-ours",
        text: "The prompt is gavin's own panel, not a macOS dialog, and lists what STAYS: the working/waiting tabs, any pinned idle tab, and every file or board tab",
        hint: "Set one up with all three. A pinned idle tab must be named as spared, not silently closed.",
      },
      {
        id: "close-idle-closes-once",
        text: "Confirm: exactly those tabs close, in one pass, with no second confirmation — and the busy and pinned ones are still there",
        hint: "Turn the workspace's “Close confirm” setting ON first: this prompt replaces it, so a second dialog is the bug.",
      },
      {
        id: "close-idle-empties",
        text: "The prompt warns before it takes a whole pane or the whole page: idle tabs filling one pane of a split say “1 pane … closes too”, and a page with nothing but idle tabs says the page closes with them — and it does",
        hint: "The page really disappears from the sidebar. Cancel must leave every tab exactly as it was.",
      },
      {
        id: "close-idle-other-page",
        text: "Do it on a page you are NOT looking at: its tabs close and the view stays put",
        hint: "Another workspace's page too — closing tabs there must not switch workspaces.",
      },
    ],
  },
  {
    title: "App header",
    items: [
      {
        id: "header-full-height",
        text: "The hub tabs and a page's tabs sit at the very top of the window; only the traffic lights' strip is above the sidebar, and nothing spans the window any more",
        hint: "The strip and both tab rows are the same height, so the sidebar's first row (“Gavin”) starts on exactly the line the view beside it does — and switching between a hub tab and a page must not nudge the content up or down.",
      },
      {
        id: "header-page-tabs-match-hub",
        text: "A page's tabs are the same size as the hub tabs above the Kanban board — same height, same text",
        hint: "They were smaller (4/8px at 0.8em against 6/10px at 0.85em). Both take their metrics from theme.css now, so a difference is a regression rather than a tweak.",
      },
      {
        id: "header-page-tab-indicator",
        text: "The active tab of the FOCUSED pane is underlined in the workspace's accent, the way the active hub tab is — split the page and the underline follows the focus, one pane at a time",
        hint: "It used to be a blue bar over the tab. An uncoloured workspace falls back to the same amber the hub tabs use.",
      },
      {
        id: "header-pane-controls",
        text: "Every pane's own tab row ends with Split Right, Split Down and Close Pane, and each acts on THAT pane — split the page in two and check both",
        hint: "They used to be app-wide and addressed “the focused pane”, which a hub tab kept but never showed; from there Split spawned a session into a page nowhere on screen. On the pane there is nothing to get wrong.",
      },
      {
        id: "header-tab-chips-moved",
        text: "The plan and diff buttons are on the tab row's right, not inside the tab: run a card, and the tab carries a label and a close box while the row offers Show plan and See what this run changed",
        hint: "Both act on the ACTIVE tab — switch tabs in that pane and they appear, change or go. Each still opens its pane beside the agent rather than over it.",
      },
      {
        id: "header-tabs-scroll",
        text: "Open enough tabs (and shrink the window) to overflow a row, then scroll it with a plain mouse wheel over the tabs — the row scrolls sideways and the actions on its right never move",
        hint: "Both rows: a pane's tabs and the workspace's hub tabs. A trackpad's sideways swipe works too, and once the row is at either end the wheel goes back to whatever is under it.",
      },
      {
        id: "bar-new-page-menu",
        text: "“New page” is a “+” with a chevron at the right of both rows; clicking it drops a menu TITLED “New page” over the presets — Single, Side by Side, 2×2 Grid",
        hint: "The menu is the app's one context-menu layer, so Escape, a click elsewhere and the window losing focus all close it, and a second click on the button closes it rather than reopening it.",
      },
      {
        id: "bar-new-page-lands",
        text: "Picking a preset adds a page with that layout to the current workspace AND brings it on screen — do it from a hub tab and from a pane's row, not only from one of them",
        hint: "Sessions start in the workspace's bound root, and the page is named after the count it already had (Page 3, Page 4…). The app hub has no row of its own; the sidebar's per-workspace + is the route from there.",
      },
      {
        id: "bar-new-page-with-agent-toggle",
        text: "“With agent” heads the menu as a checkbox: clicking it ticks it and the menu STAYS OPEN, so the preset under it is still one click away",
        hint: "It qualifies the rows under it rather than being a fourth thing to pick. A menu that closed on the tick would hide the state it just set.",
      },
      {
        id: "bar-new-page-with-agent-lands",
        text: "With it ticked, a preset opens every pane on the workspace's configured agent instead of a bare shell — try 2×2 and confirm all four panes are agents",
        hint: "The agent is the one Settings names for this workspace; a 2×2 spends four sessions on it.",
      },
      {
        id: "bar-new-page-with-agent-forgets",
        text: "Untick it, or reopen the menu after adding an agent page, and the box is still whatever you last left it — but a fresh app start has it clear",
        hint: "Deliberately not a stored preference: a tick remembered from last week would spend agent sessions on a page asked for as terminals. Each row's button keeps its own tick, so check the one you are using.",
      },
      {
        id: "header-window-drag",
        text: "The window still moves: drag it by the strip beside the traffic lights, and by the empty run of the hub tab row after the last tab",
        hint: "Double-clicking either one zooms the window (or whatever “Double-click a window's title bar to” is set to). The strip is all that is left of the old full-width bar, which is why the hub row gives some of the room back.",
      },
      {
        id: "header-pane-drag-unchanged",
        text: "The empty part of a PANE's tab row still drags the pane, not the window — grab it and drop the pane elsewhere on the page",
        hint: "The one row that deliberately does not move the window: a bar that did either depending on invisible state would be worse than a small handle.",
      },
      {
        id: "header-rows-one-black",
        text: "A page's tab row is the same black as the terminal under it and as the hub tab row — no grey band across the top, and no grey margin around the active tab",
        hint: "It used to be --surface-raised, the colour the sidebar's strip still is. Switch between a hub tab and a page and the only thing that changes above the view is the tabs themselves. Check the light theme too.",
      },
      {
        id: "header-tab-dividers",
        text: "A short vertical hairline sits between neighbouring tabs on BOTH rows, stopping well short of the row's height",
        hint: "It is what separates the tabs now that no tab has a fill of its own. Full height would read as a box around each tab. The first tab of a row has none to its left.",
      },
      {
        id: "header-one-action-group",
        text: "Split a page in two: only ONE row of actions is drawn, on the focused pane — click into the other pane and the whole group moves there with the underline",
        hint: "Every pane used to draw its own, four copies on a 2×2. Split further and check no pane is ever left without one — New page lives in that group.",
      },
      {
        id: "header-workspace-settings-gear",
        text: "Settings is a gear at the right of the hub tab row, not a tab: click it to open the Settings view, and it stays lit while that view is on screen",
        hint: "The strip has one tab fewer, so ⌘1–⌘9 and the hold-⌘ badges must line up with the tabs that are left. The root banner's “Open settings” and the sidebar's recap still land there too.",
      },
      {
        id: "close-window-keeps-sessions",
        text: "Close the window (⌘W on the window, the red light, ⌘Q): the prompt offers Close window / Keep open with an unticked “End every terminal session too” — close with it UNTICKED and reopen; every session is still there",
        hint: "The box must come up clear every time. Escape and Keep open both leave the window open.",
      },
      {
        id: "close-window-kills-sessions",
        text: "Close it again with the box TICKED: every terminal and agent is gone when the app is reopened — not just the tabs, the sessions behind them",
        hint: "Check with the Sessions manager after relaunching, not just by counting tabs. Leave a long-running command in one tab first. Anything already written to disk stays.",
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
    title: "A surviving orphan agent",
    items: [
      {
        id: "orphan-none-for-a-normal-agent",
        text: "Run a card, wait until the agent is working, restart the daemon: the tab's badge is the AMBER ↻, not a red ⚠ — no agent gavin ships survives the restart",
        hint: "Measured per profile under a temp $HOME: claude, gemini and opencode all take the SIGHUP a closing PTY master sends and die. The probe is still correct and costs one syscall per inherited row; a red ⚠ here would mean an agent version changed its signal handling, which is worth knowing.",
      },
      {
        id: "orphan-detected",
        text: "In a terminal tab run `trap '' HUP; sleep 900`, restart the daemon: THAT tab comes back with a red ⚠ badge naming the pid",
        hint: "The only reliable way to produce a real orphan by hand. It is exactly what a future agent that ignores SIGHUP would do, and what the epoch could never detect — the epoch describes a daemon lifetime, not a process.",
      },
      {
        id: "orphan-survives-reload",
        text: "With that ⚠ up, reload the frontend (⌘R under tauri dev): the badge comes back",
        hint: "The push is baselined on Attach, which happens once per app PROCESS. Without the get_session_baselines read-back a reload hides a live agent behind an ordinary-looking tab.",
      },
      {
        id: "orphan-survives-second-restart",
        text: "Restart the daemon a SECOND time without ending it: the ⚠ is still there, still naming the same pid",
        hint: "By then the row's own process is the bare shell the first recovery spawned, and shells die with their daemon. recover() re-probes the recorded orphan first for exactly this.",
      },
      {
        id: "orphan-confirm-names-it",
        text: "Click the ⚠: the confirmation names the command and the pid, and says edits already written to disk stay",
        hint: "Killing something gavin no longer hosts is outside what the session owns and has no undo. A prompt that said “end the orphaned process?” would not be a confirmation.",
      },
      {
        id: "orphan-ended",
        text: "Confirm: the badge goes away, and `ps -p <pid>` shows nothing",
        hint: "Success is silent — the badge disappearing is the feedback. The daemon WAITS for the process to actually exit before clearing the row.",
      },
      {
        id: "orphan-refuses-sigterm",
        text: "Repeat with `trap '' HUP TERM; sleep 900`: after confirming, the badge STAYS and a message says it is ignoring SIGTERM and offers `kill -9`",
        hint: "Nothing escalates to SIGKILL on its own. Dropping the badge here would be the app reassuring the human about something it just watched fail.",
      },
      {
        id: "orphan-copy-softens-on-an-old-daemon",
        text: "Against a daemon older than v22, an interrupted tab's tooltip does NOT claim the process is gone — it says the daemon is too old to check",
        hint: "The setupProgress trap. `orphan: null` from a v21 daemon means nobody looked, not that nothing survived, and min_version_for cannot see the difference — FEATURE_MIN_VERSION.orphanDetection is the only gate there is.",
      },
    ],
  },
  {
    title: "Task manager",
    items: [
      {
        id: "tasks-opens-from-the-sidebar",
        text: "The sidebar footer has a “Task manager” row above Settings; it opens a panel listing every open terminal across every workspace",
        hint: "One list for every workspace, not the active one: a session left running in a workspace nobody has open is exactly the kind this exists to find.",
      },
      {
        id: "tasks-figures-appear-on-the-second-poll",
        text: "CPU reads “—” for the first two seconds, then fills in; memory is there immediately",
        hint: "A rate needs two samples and the interval between them. Memory is an instantaneous reading, so it has an answer straight away — the two columns are deliberately not the same kind of number.",
      },
      {
        id: "tasks-cpu-counts-the-whole-tree",
        text: "In a terminal tab run `yes > /dev/null`: that row climbs to ~100%. Run four of them in one tab (`for i in 1 2 3 4; do yes > /dev/null & done`): the ONE row reads ~400%",
        hint: "The figure covers the session's process and everything it started, and is not clamped at 100. A shell showing 0.2% while its children pin four cores is the failure this shape avoids.",
      },
      {
        id: "tasks-totals-sum-the-two-columns",
        text: "Under the last row a pinned “Total” line sums the CPU and Mem columns and names what it covers (“14 sessions · 37 processes”); start four `yes > /dev/null` in one tab and the total climbs by ~400% too",
        hint: "It is a `<tfoot>` INSIDE the table, not a strip under the grid: `table-layout: fixed` makes the columns exact, and anything outside would be a scrollbar's width out of line the moment the list overflows.",
      },
      {
        id: "tasks-totals-stay-at-the-foot",
        text: "With ~30 terminals open, the Total line stays at the bottom of the grid while the rows scroll under it — the mirror of the headings staying at the top",
        hint: "Sticky is on the CELLS, never on `<tfoot>` or `<tr>`: this is WKWebView, and a cell is the form it has always honoured. What the fleet costs must not scroll away.",
      },
      {
        id: "tasks-totals-wait-for-a-rate",
        text: "For the first two seconds the total CPU reads “—”, never 0.0%; open a new terminal and for one poll the coverage line reads “… · 1 not rated yet”, with the reason on hover",
        hint: "A total that counted an unrated row as zero would be the one lie the per-row arithmetic was written to avoid, told once more at the bottom of the table. Hover also says what kind of number each sum is — shares of ONE core, and resident sizes that count a shared page twice.",
      },
      {
        id: "tasks-hidden-session-listed",
        text: "Press “Commit via agent” on the Git tab and open the panel while it runs: the hidden run is listed, marked with no tab",
        hint: "The card's “invisible sessions”. A commit agent, an orchestration Organize and a rail's Reorganize all run with nothing rendering them; before this they were visible only as a spinner.",
      },
      {
        id: "tasks-jump-opens-a-tab-for-a-hidden-one",
        text: "Press ↗ on that hidden row: it gets a tab on the workspace's Agents page and the panel closes onto it",
        hint: "Same adoption path as the Git tab's “watch this run” button (handleAgentSessionSpawned), so a hidden session is never adopted twice by two different routes.",
      },
      {
        id: "tasks-main-agent-goes-to-home",
        text: "With a main agent panel running, press ↗ on its row: it goes to the workspace's Home tab, NOT onto a page as a new tab",
        hint: "The main session lives outside every page tree (D12). Adopting it onto a page would move it out of the panel that owns it.",
      },
      {
        id: "tasks-stale-rows-sort-first",
        text: "With an orphan present (`trap '' HUP; sleep 900`, then restart the daemon), its row is at the TOP with a red ⚠, State reads “orphaned”, and a line under the name says it did not stop",
        hint: "The default order is State, attention first — never CPU, which would make rows swap places under the pointer every two seconds in a panel whose buttons kill processes.",
      },
      {
        id: "tasks-grid-sorts-by-heading",
        text: "Click the Name heading: rows go A→Z with a ▲ beside it; click again for Z→A. Click Mem: the biggest tree is FIRST on the first click. Click State to get the default back",
        hint: "Memory starts descending because nobody sorts by memory to find the smallest shell. Only the sorted column reverses — rows equal on it keep one readable order.",
      },
      {
        id: "tasks-multi-select",
        text: "Click a row (highlighted), ⇧click three rows down (the range is selected), ⌘click one of them (it drops out): the header button reads “Kill N selected…” with the right N, and the foot names the keys",
        hint: "The platform's list grammar, reduced in sessionsManager.ts (selectRow). The range follows the DISPLAYED order, so under a Mem sort it is the rows you can see between the clicks.",
      },
      {
        id: "tasks-kill-selected-names-them",
        text: "Press “Kill N selected…”: ONE in-app confirmation lists the picked sessions by name; confirming ends only those and the selection clears",
        hint: "The prompt is the only place a mis-click shows. With one row picked it is worded as that row's own ✕ would be.",
      },
      {
        id: "tasks-kill-selected-states-the-cost",
        text: "Select two busy sessions and press “Kill N selected…”: the prompt also says what they are using together (“Together they are using 1.4 GB of memory and 210.0% of one core.”)",
        hint: "Every other number in that prompt can be checked against the rows behind it; a sum over a SELECTION appears nowhere else on screen, and it is usually the reason someone reached for the button.",
      },
      {
        id: "tasks-clear-stale",
        text: "With an exited row and a live one, “Clear stale (1)” is enabled; pressing it asks once, spelling out what clearing an exited row does, and leaves the live row alone",
        hint: "Clearing an exited row deletes a record; clearing an orphan sends SIGTERM to a live process. One word covering both would hide the one that matters, so the prompt lists each kind present.",
      },
      {
        id: "tasks-grid-scrolls-inside",
        text: "Open ~30 terminals and open the panel: the title row, the buttons and the foot stay in place; only the grid scrolls, and the column headings stay at its top",
        hint: "Modal's innerScroll opt-in: the panel clips instead of scrolling, and the grid is the one child allowed to give way. A sticky header inside the panel's own scroller would stick to its padding edge.",
      },
      {
        id: "tasks-kill-confirms-and-names",
        text: "Press ✕ on any row: gavin's OWN confirmation (not an OS sheet) names that session and its folder, says disk edits stay, and Enter does NOT fire the red button",
        hint: "The rows look alike and the interesting ones are the ones nothing else is showing, so the prompt is the only place to check you picked the right one. It is dialog.ts's ConfirmPrompt: plugin-dialog is narrowed to the file picker, and its confirm() used to reject silently, which is why ✕ and Kill all did nothing.",
      },
      {
        id: "tasks-kill-takes-the-tab",
        text: "Kill a row that has a visible tab: the tab disappears with it, and the panel's list re-reads immediately",
        hint: "The daemon pushes session-exited for a session it was hosting, but not for a row it had already marked exited — that tab would sit there dead until the next reload.",
      },
      {
        id: "tasks-kill-ends-the-orphan-first",
        text: "Kill the orphan row: `ps -p <pid>` shows nothing AND the row is gone",
        hint: "The orphan's pid is recorded ON the session's registry row, and KillSession deletes that row. The other order would leave a live process with nothing left that knows how to end it.",
      },
      {
        id: "tasks-refusing-orphan-keeps-its-row",
        text: "With `trap '' HUP TERM; sleep 900`, kill that row: it STAYS, with a message naming the pid for `kill -9`",
        hint: "The row is where the pid is recorded. Deleting it because the human pressed a button would erase the only handle they have on a process that just refused to stop.",
      },
      {
        id: "tasks-kill-all-asks-once",
        text: "Press “Kill all…”: ONE in-app confirmation naming the count and how many are stale, with an “End all” button; confirming closes every terminal in every workspace, cancelling ends nothing",
        hint: "A prompt per session trains the human to click through prompts. One honest prompt that names the count is the whole safeguard — and it has to actually appear: the native confirm it used to call rejected at the permission layer, so the button did nothing.",
      },
      {
        id: "tasks-poll-stops-on-close",
        text: "Close the panel and leave the app idle: the daemon's CPU use drops back to nothing",
        hint: "The panel is the only reason the daemon walks the process table. A poll that outlives the modal is a permanent background cost for a panel nobody has open.",
      },
      {
        id: "tasks-old-daemon-still-manages",
        text: "Against a daemon older than v23, the list still shows every session and still kills them — the two figure columns say why they are empty instead of reading 0",
        hint: "ListSessions has been in the protocol since v1, so jumping and killing work all the way down. Blank cells would read as “this session is using nothing”, which is a measurement nobody took.",
      },
      {
        id: "tasks-restart-asks-with-this-list",
        text: "With several terminals open, press “Restart daemon…”: ONE in-app confirmation counts the sessions in THIS list (“All 7 sessions…”), names how many no tab is showing, and Enter does NOT fire the red button",
        hint: "Settings can only say “every terminal session”; this panel knows the number, and a number the human can check against the rows behind the dialog is how they tell a quiet restart from an expensive one.",
      },
      {
        id: "tasks-restart-cancel-changes-nothing",
        text: "Cancel that prompt: the button never says “Restarting…”, the figures keep updating every two seconds, and no session moves",
        hint: "`restarting` both labels the button and stops the poll, so it is set only once the human has said yes. Setting it at the click would put a button reading “Restarting…” behind a dialog still asking whether to.",
      },
      {
        id: "tasks-restart-rebuilds-every-row",
        text: "Confirm it: the button reads “Restarting…”, no “Couldn’t read the session list” error flashes, and when it returns every row is a plain shell at the same folder with “Daemon restarted at HH:MM” above the grid",
        hint: "The socket is closed and re-made underneath the panel. The poll is suppressed for the whole restart and any reply already in flight is discarded — otherwise a successful restart reports itself as a failure to read the list.",
      },
      {
        id: "tasks-restart-interrupts-an-agent",
        text: "Run a card from the board, wait until the agent is clearly working, then restart from this panel: its row comes back as a shell marked “interrupted”, and the card offers Resume rather than starting the prompt over",
        hint: "The confirmation promises exactly this, and the promise is version-dependent: on a daemon older than v20 the command is RE-RUN from the beginning, and the prompt says so instead (restartStopsAgentsLine, shared with the Settings prompt).",
      },
      {
        id: "tasks-restart-does-not-end-an-orphan",
        text: "With an orphan present (`trap '' HUP; sleep 900`, then restart once), open the panel and restart again: the prompt warns the surviving process will NOT be ended, and afterwards that row is still orphaned with the same pid",
        hint: "recover() re-probes a recorded survivor and keeps it when it is still alive. Someone reaching for Restart to be rid of an orphan would be picking the one action that cannot do it, so the prompt says so before they press it.",
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
    title: "Review with agent",
    items: [
      {
        id: "review-git-tab-dialog",
        text: "The Git toolbar's “Review” opens the base dialog, seeded with the repo's trunk rather than the branch you are standing on",
        hint: "On a topic branch it should say main (or master). Standing ON main it falls back to the upstream — reviewing a branch against itself has an empty diff.",
      },
      {
        id: "review-rules-row",
        text: "That dialog says whether the workspace has review rules, and “Create .gavin-root/REVIEW.md” writes a starter file and flips the row",
        hint: "Re-open it after creating: the row now names the file and offers nothing. A workspace that already has one must never see the Create link.",
      },
      {
        id: "review-visible-session",
        text: "Starting the review opens a VISIBLE session, jumps to it, and names the tab “review”",
        hint: "Unlike Commit via agent, which is hidden. Nothing on the board changes: no card moves, no session dot appears.",
      },
      {
        id: "review-files-cards",
        text: "The review's findings arrive on the board as cards — one per finding, titled by the defect, in the first column",
        hint: "Review a branch that has a real bug in it. A clean review must file NOTHING and say so.",
      },
      {
        id: "review-card-menu",
        text: "A card's “Review with agent…” reviews that card's work and files findings NESTED inside it when the card is a plan",
        hint: "A task card's findings stand on their own instead (only a plan can be a parent) and name the card in the body.",
      },
      {
        id: "review-card-menu-always",
        text: "That entry is on a card whatever its session state — running, exited, Done — and never on a note",
        hint: "A card is worth reviewing because work happened on it; the states that hide Run are exactly the interesting ones.",
      },
      {
        id: "review-card-untouched",
        text: "A card review leaves the card alone: no status change, no binding, and its own agent keeps running undisturbed",
      },
      {
        id: "review-rail-step",
        text: "The rail step “Review this branch” files cards too, not just a paragraph in its terminal",
        hint: "Drop it on a rail and run it. Its findings should look like the ones the Git tab produced.",
      },
      {
        id: "review-blocked-explains",
        text: "With an agent that takes no prompt (Cursor), the toolbar's Review is greyed out AND hovering it says why",
        hint: "The reason hangs on the wrapping span — a disabled button never fires mouseenter.",
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
      {
        id: "wt-setup-notice",
        text: "With `[worktree] setup = [\"npm install\"]` in .gavin-root/config.toml, New worktree… names the command it will run — and names nothing when the block is absent",
        hint: "The dialog shows the exact line, agent chained on the end when “Start agent here” is ticked. Untick it and the line is the setup alone. A config.toml with no [worktree] block, or one that doesn't parse, must show no notice and still create the worktree.",
      },
      {
        id: "wt-setup-runs",
        text: "Creating that worktree opens ONE session in it running the setup, with the agent starting only after the setup succeeds",
        hint: "Make setup a command you can watch (`sleep 5 && npm install`). One tab, not two: the agent's prompt must not appear until the setup has finished. Then point setup at a command that FAILS (`false`) — the agent must never start, and the failure stays on screen.",
      },
      {
        id: "wt-sweep-badge",
        text: "Opening the switcher marks every finished fork with a green “stale” badge — and marks none of the four kinds that must be kept",
        hint: "Make four forks off a merged branch and disqualify one each: leave an untracked file in the first, bind a rail to the second, open a terminal in the third, and leave the fourth's branch unmerged. Only the untouched one carries the badge. Then commit nothing and just SAVE a file in the badged one — reopen the menu and the badge is gone, because the facts are re-read on open.",
      },
      {
        id: "wt-sweep-run",
        text: "“Sweep stale (N)” lists exactly those N folders with their reasons, asks ONCE, and removes them all — with “Also delete the N merged branches” ticked by default",
        hint: "The button says “Remove N worktrees”, red, with focus on “Keep them” so Enter cannot fire it. Untick the checkbox on a second run: the folders go, the branches stay (check `git branch`). With nothing stale the button says so in an alert naming what it kept, rather than doing nothing.",
      },
      {
        id: "wt-sweep-current",
        text: "Sweeping the worktree the Git tab is currently POINTED at moves the tab back to the root checkout instead of leaving it on a deleted folder",
        hint: "Switch to a stale fork first, then sweep. No “directory not found” banner should appear.",
      },
      {
        id: "wt-setup-rail",
        text: "Orchestration → bind a rail → New worktree…: the setup session opens on the RAIL's page, in the new worktree",
        hint: "This is the path with no “Start agent here” checkbox at all, and the one that used to hand the dialog a no-op. Check the session's cwd is the fork (not the workspace root) and that it landed on the page named after the rail rather than on the page you were looking at. The rail itself stays idle — this is not a run row.",
      },
    ],
  },
  {
    title: "Best-of-N card run",
    items: [
      {
        id: "bon-dialog-preview",
        text: "Card menu → “Run on several agents…” opens on two rows — one agent at two models where the workspace's agent has them — and each row names the branch it will create",
        hint: "The branch column is derived from the card TITLE plus the agent and model, and skips past names the repo already has: make a branch called `<card-slug>-<profile>-<model>` by hand first and the row must offer `…-2`. Add rows up to six; the × is disabled at two, because one candidate is just Run. Two identical rows must refuse with a sentence, not a silent disabled button.",
      },
      {
        id: "bon-launch",
        text: "Starting the run creates one worktree per candidate and opens them tiled on ONE page named after the card, each terminal in its own folder",
        hint: "Two candidates side by side, three in a row, four as a 2×2. Check each pane's cwd is its own fork (`pwd`), and that with `[worktree] setup` declared each pane runs the setup BEFORE its agent. The card goes In Progress once, not once per candidate. Point the Git tab at some OTHER worktree first and start a run: the dialog must say it forks from the main checkout's branch, and `git log <candidate-branch>` must not carry that other fork's commits.",
      },
      {
        id: "bon-tab-names",
        text: "Each candidate's tab is named for its agent and model, and the agent's own rename keeps that label at the front",
        hint: "Before any agent has drawn a frame the tabs already read “Claude Code · opus” and “Claude Code · sonnet”. After they name themselves the labels must still start with the candidate — that is the only thing telling the panes apart.",
      },
      {
        id: "bon-no-second-run",
        text: "While a run is in flight the card's menu offers only “Best of N — pick a candidate…”, never a second Run",
        hint: "The candidates are not bound to the card, so this is the guard that stops a second run replacing the first one's record and orphaning its folders. The entry opens the card detail, where the run's panel is.",
      },
      {
        id: "bon-pick",
        text: "“Keep this one” asks once, naming every folder it will delete, then closes the losing tabs, removes their worktrees and binds the winner to the card",
        hint: "Red button, focus on “Keep watching” so Enter cannot fire it. Afterwards: the losing folders are gone (`git worktree list`), the winner's is not, and the card's Agent session block shows the winner with a working Jump. Merging must NOT have happened — the branch is still unmerged on the Git tab. Untick the branches box and the losing branches survive in `git branch`. Then run it once more with the Git tab POINTED at a loser: the tab moves back to the root checkout and the removal still succeeds, because git refuses to remove the worktree it is run from.",
      },
      {
        id: "bon-pick-from-tab",
        text: "The same pick is on each candidate tab's right-click menu, from the page where they are being watched",
        hint: "Right-click a candidate's tab: “Keep this candidate, discard the other…”. A tab that is not part of a run must show nothing of the sort.",
      },
      {
        id: "bon-discard",
        text: "“Discard the run…” in the card detail throws all of them away and leaves the card's status where the run put it",
        hint: "The card stays In Progress and gains no binding. Every fork's folder is gone.",
      },
      {
        id: "bon-survives-reload",
        text: "The run survives a frontend reload: the card detail still lists its candidates and can still pick one",
        hint: "⌘R with a run in flight. The record is in localStorage, so the panel comes back with the same candidates. Close one candidate's tab by hand first — it must come back listed as stopped rather than dropped, because its folder is still on disk.",
      },
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
    // The two tabs that open with a search over a wide surface. Their
    // first rows had drifted into different shapes, and neither file can
    // see the other, so the check is "do these two still look like one
    // thing".
    title: "The tabs' first row",
    items: [
      {
        id: "first-row-kanban-width",
        text: "Kanban: the search box spans the row like Orchestration's, not an input-sized stub",
        hint: "Both cap at the same width, so a wide window leaves the same gap on each tab.",
      },
      {
        id: "first-row-kanban-rule",
        text: "Kanban: a rule runs under the whole bar, separating the lens from the columns",
        hint: "Narrow the window until the facets wrap — the rule stays under the last row of controls, not through them.",
      },
      {
        id: "first-row-orch-heading",
        text: "Orchestration: the row opens straight on the search box — no “Orchestration” heading",
        hint: "The hub's tab strip above already names the view; the heading only repeated it and cost the row width.",
      },
    ],
  },
  {
    title: "Orchestration rail scrolling",
    items: [
      {
        id: "rail-scroll-per-rail",
        text: "A rail with more steps than fit scrolls on its own: its stages move, every other rail stays exactly where it was",
        hint: "Needs two rails of very different lengths. Scroll the long one to its bottom, then look at the short one — before this change the whole grid moved as one, so the short rail's steps went off the top with it.",
      },
      {
        id: "rail-scroll-header-fixed",
        text: "The scrolled rail's header — name, worktree/page chips, state, buttons — stays put and never scrolls away",
        hint: "Same result as the old sticky header, reached differently: it now sits outside the scroller instead of sticking inside it. Watch its bottom border: it must not slide over a step, and no step may show through above it.",
      },
      {
        id: "rail-scroll-no-page-scroll",
        text: "No vertical scrollbar on the grid itself, and “+ Add step” is reachable at the foot of a long rail",
        hint: "The strip keeps only its horizontal bar. If the tail of a long rail is CLIPPED rather than scrollable, the rail lost its height — that is the failure this replaced the shared scroll with.",
      },
      {
        id: "rail-scroll-drag-autoscroll",
        text: "Dragging a step to the bottom edge of a long rail auto-scrolls THAT rail, and the drop lands where the indicator sat",
        hint: "Hold the chip near the rail body's lower edge: its stages should creep up under the pointer. Dragging past the left or right edge still scrolls the grid sideways.",
      },
      {
        id: "rail-scroll-foot-above-hbar",
        text: "With enough rails to scroll the strip sideways and a legacy horizontal scrollbar showing, the foot of a long rail — the whole “+ Add step” button — sits above the bar, not under it",
        hint: "A legacy bar needs a mouse plugged in, or System Settings → Appearance → Show scroll bars: Always; a trackpad's overlay bar takes no space and cannot show this. WebKit sized the old grid's row track without subtracting its own bar, so every rail ran 17px under it and the button lost its bottom edge.",
      },
      {
        id: "group-head-wraps-under-long-name",
        text: "A group whose name is too long for one row beside its sequence/parallel toggle drops the toggle and ⋯ to a second row; the name keeps its one row and ellipsises only when even the full width is too narrow",
        hint: "Narrow the window until the rails are 280px and give a group a long name — a short name keeps the single row, and the controls sit at the right edge on either row. The drag grip stays on the name's row.",
      },
    ],
  },
  {
    title: "Orchestration rail header",
    items: [
      {
        id: "rail-header-name-readable",
        text: "With six or more rails on the grid, every rail's name is readable in full on the header's first row",
        hint: "Give one rail a long name (\u201cReview the attachments pipeline\u201d). At 280px a rail used to spend that whole row on six buttons and the state word, leaving the name two characters and an ellipsis.",
      },
      {
        id: "rail-header-actions-second-row",
        text: "All of the rail's buttons — start/pause, wand, reset, move-all, clear-done, delete — sit on ONE row directly under the name",
        hint: "None may wrap to a third row, even on the narrowest rail: a header that reflows costs more height than the name gained width.",
      },
      {
        id: "rail-header-state-stays-whole",
        text: "On a running rail that is waiting on you, “running” and “needs you” stay whole beside the name and the NAME is what ellipsises",
        hint: "Start a rail and let its agent ask a question. If “needs you” is the thing that gets clipped or wraps, the flex weights went the wrong way round.",
      },
    ],
  },
  {
    title: "Rail bindings dialog",
    items: [
      {
        id: "bind-chips-three",
        text: "A rail header shows THREE binding chips — worktree, branch, page — and each opens the dialog on its own tab",
        hint: "Worktree and branch share the first line, the page has the second. Hover each: an unset one says what the default does (\u201ceach card's own folder\u201d, \u201cwhatever is checked out\u201d, \u201ca page of its own at first launch\u201d), a set one says the whole worktree path the chip abbreviates to a folder name.",
      },
      {
        id: "bind-chips-narrow",
        text: "At 280px the chips ellipsise their VALUE and keep their glyphs, and the header stays at the same height as before",
        hint: "Bind a rail to a worktree with a long folder name and a long branch. Nothing may wrap to a fourth header row.",
      },
      {
        id: "bind-tab-strip",
        text: "The dialog is a tab strip: Worktree / Branch / Page, each tab showing what that binding is set to right now",
        hint: "Only one list is on screen at a time. Picking a value updates the tab's own sub-label immediately, without leaving the tab.",
      },
      {
        id: "bind-tab-keys",
        text: "With a tab focused, \u2190/\u2192 move across the strip (wrapping) and Home/End jump to the ends; Escape still closes the dialog",
        hint: "Escape is the one that matters: a tablist that swallows it leaves the modal stuck open.",
      },
      {
        id: "bind-tab-deep-link",
        text: "The conflict box's repair button names the binding it repairs and lands on that tab",
        hint: "A rail bound to a deleted branch offers \u201cPick another branch\u201d and opens on Branch; a deleted worktree offers \u201cPick another worktree\u201d; a rail with no worktree offers \u201cGive it a worktree\u201d. All three used to say \u201cBind worktree…\u201d and open at the top.",
      },
      {
        id: "bind-tab-height",
        text: "Switching tabs does not resize the dialog under the pointer",
        hint: "The Page tab on a workspace with one page is the short one — the panel keeps a floor so the Done button stays put.",
      },
    ],
  },
  {
    title: "Rail branch/worktree defaults",
    items: [
      {
        id: "rail-seed-new-branch",
        text: "Bind a rail → “New branch…”: the field opens already holding the rail's name, slugged (“Auth rework” → auth-rework)",
        hint: "The old field opened empty on a “feature/thing” placeholder. Rename the rail and reopen — the seed must follow the new name. Cancel after typing over it, reopen: the seed is back, not your half-typed name.",
      },
      {
        id: "rail-seed-branch-dedupe",
        text: "With that branch already in the repo, the field opens on “…-2” instead, and Create and bind is enabled from the start",
        hint: "The point of the dedupe: no default may open on “Branch already exists — pick it above”. Make auth-rework and auth-rework-2, reopen — it should offer auth-rework-3.",
      },
      {
        id: "rail-seed-new-worktree",
        text: "Bind a rail → “New worktree…”: the branch field carries the same seed, and the folder line under it follows with <repo>-<seed>",
        hint: "One seed feeds both, because the folder tracks the branch until you edit it. Type in the folder and then change the branch: your folder must stay yours.",
      },
      {
        id: "rail-seed-git-tab-unseeded",
        text: "The Git tab's own Switcher → “New worktree…” still opens EMPTY on its placeholder",
        hint: "There is no rail there to name it after. A seed leaking into this dialog would name every worktree after whichever rail was bound last.",
      },
      {
        id: "rail-seed-unslugabble",
        text: "A rail named only in symbols (“???”) leaves both fields empty on their placeholders rather than seeding junk",
      },
    ],
  },
  {
    title: "Running every idle rail",
    items: [
      {
        id: "run-all-placement",
        text: "The Orchestration toolbar's “Run all” sits between “Organize with agent…” and “+ Rail”",
      },
      {
        id: "run-all-dead-when-nothing",
        text: "With every rail either running or empty, “Run all” is greyed and its tooltip reads “No idle rail has anything left to run”",
        hint: "Test both halves: a workspace with no rails at all, and one whose only rail has every step already done. Neither may offer a live button.",
      },
      {
        id: "run-all-confirm-names-rails",
        text: "Pressing it opens the confirm naming each rail it will start, by name, in the order they sit on screen",
      },
      {
        id: "run-all-starts-idle-only",
        text: "Confirming flips every idle non-empty rail to running; the rails already running keep their own current stage",
        hint: "The one that matters: leave a rail running on its SECOND stage with a stalled step behind it, then Run all. That rail must not rewind to stage 1.",
      },
      {
        id: "run-all-leaves-paused",
        text: "A paused rail stays paused, and the confirm said so before you pressed",
      },
      {
        id: "run-all-each-gets-a-page",
        text: "Each rail started this way lands its sessions on its own page, exactly as pressing its own Start would",
        hint: "Unbound rails get a page created at Start (spec O16) — check the sidebar grew one page per rail, not one shared page.",
      },
      {
        id: "run-all-cancel",
        text: "Cancelling the confirm starts nothing — every rail is still idle",
      },
    ],
  },
  {
    title: "Clearing finished rails",
    items: [
      {
        id: "clear-done-rails-placement",
        text: "The Orchestration toolbar's “Clear done” sits between “Run all” and “+ Rail”",
      },
      {
        id: "clear-done-rails-dead-when-nothing",
        text: "With no rail finished, “Clear done” is greyed and its tooltip reads “No rail has finished every step it holds”",
        hint: "Check the vacuous case too: a brand-new EMPTY rail must not make the button live. An empty rail is unstarted, not finished.",
      },
      {
        id: "clear-done-rails-confirm-names-them",
        text: "Pressing it opens the confirm naming each rail it will remove, by name, in the order they sit on screen",
      },
      {
        id: "clear-done-rails-removes-them",
        text: "Confirming removes exactly those rails, and the rails with work left are still there in their old order",
      },
      {
        id: "clear-done-rails-cards-stay",
        text: "The cards those rails carried are untouched — still on the Kanban tab, still in their columns, and the confirm said how many would stay",
        hint: "The whole promise: a rail is a plan over cards, not a container of them. Check the drawer got them back as unplaced.",
      },
      {
        id: "clear-done-rails-worktree-stays",
        text: "A bound finished rail's worktree is still on disk and still listed on the Git tab; the confirm named it before you pressed",
      },
      {
        id: "clear-done-rails-skipped-counts",
        text: "A rail whose last step you SKIPPED counts as finished, and the confirm says so in its own line rather than calling the skip done",
        hint: "The rail has nothing left to run, which is what the skip meant. Excluding it would make one skip leave a rail unclearable forever.",
      },
      {
        id: "clear-done-rails-leaves-paused",
        text: "A finished rail that is paused is left standing, and the confirm accounted for it",
      },
      {
        id: "clear-done-rails-cancel",
        text: "Cancelling the confirm removes nothing — every rail is still on the tab",
      },
      {
        id: "clear-done-rails-survives-reload",
        text: "The removed rails are still gone after a reload — the plan was written, not just re-drawn",
      },
    ],
  },
  {
    title: "Orchestration agent runs",
    items: [
      {
        id: "orch-agent-own-tab",
        text: "“Organize with agent…” opens a NEW agent tab on the Agents page, named “Organize”, and lands you in it — the Home agent's terminal is untouched",
        hint: "The whole change: it used to bracket-paste into the Home agent and hop to Home. Check the Home terminal received nothing.",
      },
      {
        id: "orch-agent-no-home-agent-needed",
        text: "With the workspace's Home agent STOPPED, Organize still works — no “Start the workspace agent on Home first”",
      },
      {
        id: "orch-agent-rail-wand",
        text: "A rail's wand does the same for that rail, in a tab named “Reorganize “<rail>””",
      },
      {
        id: "orch-agent-organize-parallelizes",
        text: "An Organize run comes back with the unplaced cards spread across SEVERAL rails, not queued into one",
        hint: "Give it four or five unrelated cards. One long rail is the arrangement they already had — the button is the request to parallelize, and the skill's §2 says so.",
      },
      {
        id: "orch-agent-organize-cuts-worktrees",
        text: "The rails it adds come back BOUND: each one that runs beside another names a worktree that exists on disk and a branch, and the Conflicts box shows no “worktree is gone”",
        hint: "git worktree list in the root: the folders are really there, cut by the agent, not just named. Check the setup from [worktree] setup ran in each (node_modules/target present).",
      },
      {
        id: "orch-agent-names-itself",
        text: "Once the agent is up it renames its own tab (gavin_name_session) — the app's provisional name is only the first second or two",
      },
      {
        id: "orch-agent-one-slot",
        text: "While one run is going, the header button reads “Organizing…”/“Agent running…” and EVERY rail wand jumps to that tab instead of starting a second",
        hint: "Hover each: the tooltip names the run holding the slot. Two of these agents at once would overwrite each other's plan.",
      },
      {
        id: "orch-agent-frees-on-idle",
        text: "When the agent finishes its turn and sits quiet, the buttons go back to offering a fresh run — within a couple of seconds, without touching anything",
        hint: "It must NOT free while the agent is mid-question: ask it something and leave it waiting — the slot stays held.",
      },
      {
        id: "orch-agent-survives-restart",
        text: "Quit and relaunch the app while a run is going: the button still says a run is going and still jumps to that tab",
        hint: "This is the “with resume” half — the record lives in config.json, not in memory.",
      },
      {
        id: "orch-agent-frees-after-daemon-restart",
        text: "Restart the DAEMON while a run is going: the tab comes back as a bare shell and the buttons free themselves",
        hint: "An interrupted session keeps its old id, so “is it still in the layout” is not enough — this is the case that would otherwise lock the button forever.",
      },
      {
        id: "orch-agent-frees-when-tab-closed",
        text: "Closing the run's tab frees the buttons too",
      },
      {
        id: "orch-agent-no-root",
        text: "On a workspace with no root folder both controls are dead and say so (“no root folder — set one on the Settings tab first”)",
      },
    ],
  },
  {
    title: "The conflicts box remembers",
    items: [
      {
        id: "conflicts-collapse-sticks",
        text: "Collapse the conflicts box, switch to the Kanban tab and back — it is STILL collapsed, and the header still counts the conflicts",
        hint: "This is the whole card: one hub view is rendered at a time, so coming back rebuilds the box from scratch. Expand it again and leave — it must come back expanded too, not just remember the closed half.",
      },
      {
        id: "conflicts-collapse-survives-reload",
        text: "With it collapsed, quit and relaunch the app: the box opens collapsed",
        hint: "The answer lives in localStorage, not in the plan — nothing on the daemon changes.",
      },
      {
        id: "conflicts-collapse-per-workspace",
        text: "Collapsing it in one workspace leaves another workspace's box expanded on its first visit",
      },
      {
        id: "conflicts-collapse-not-reopened",
        text: "While it is collapsed, causing a NEW conflict (bind two rails to the same worktree) updates the count in the header without springing the box open",
        hint: "Re-opening on every change is the same annoyance in disguise. The count and the “· n live” tail are what a closed box is for.",
      },
    ],
  },
  {
    title: "Auto commit",
    items: [
      {
        id: "auto-commit-compose",
        text: "⌘N on a task or plan shows an “Auto commit” box; ticking it and filing the card puts the sentence at the foot of the card's body",
        hint: "Open the card's file: the sentence sits between two <!-- gavin:auto-commit --> comments, which the modal's preview does not draw.",
      },
      {
        id: "auto-commit-note-hidden",
        text: "Switching the composer to the note chip takes the box away — and a note filed after ticking it carries no block",
        hint: "Nothing ever executes a note, so the instruction would be text no agent reads.",
      },
      {
        id: "auto-commit-detail-toggle",
        text: "The card detail modal's “Auto commit” box matches the card, and clicking it adds or removes the sentence in the body preview",
        hint: "Off again must leave the prompt exactly as it was — no stray blank lines, no lost paragraph.",
      },
      {
        id: "auto-commit-detail-note",
        text: "A note's detail modal has no Auto commit row at all",
      },
      {
        id: "auto-commit-workspace-default",
        text: "Settings → Cards → Auto commit = On makes the next ⌘N in THAT workspace open with the box already ticked",
        hint: "The composer seeds once on open: change the setting with the composer up and the box must not move under you.",
      },
      {
        id: "auto-commit-app-default",
        text: "The app-wide Settings → Cards row moves every workspace whose own row still reads “Default (…)”, and none that chose",
        hint: "Set one workspace to Off explicitly, then flip the app-wide one to On: that workspace stays off.",
      },
      {
        id: "auto-commit-survives-restart",
        text: "Both settings survive an app restart, and an explicit Off stays Off rather than falling back to the default",
        hint: "config.json stores absence for “never chose” and false for “chose off” — they must not collapse into one.",
      },
      {
        id: "auto-commit-agent-reads-it",
        text: "Running a card that carries the block hands the agent a prompt with that sentence in it",
        hint: "The body IS the prompt, so nothing extra is injected — read the launched tab's first screen.",
      },
    ],
  },
  {
    title: "Workspace windows",
    items: [
      {
        id: "window-open-from-menu",
        text: "A workspace's sidebar menu → “Open in New Window” opens a second window showing that workspace, cascaded down-right of this one",
        hint: "The new window is the whole app: same sidebar, same hub, rounded corners and a working title-bar double-click.",
      },
      {
        id: "window-open-from-hub",
        text: "The window button on the hub tab row (left of the “+”) does the same for the workspace you are looking at",
      },
      {
        id: "window-first-looks-away",
        text: "Moving the workspace you are ON switches this window to another workspace — or to the app hub when it was the only one",
      },
      {
        id: "window-terminals-move",
        text: "A running agent's terminal comes up painted and live in the new window, and typing into it works",
        hint: "The daemon repaints from its screen model; the session is never restarted, so scrollback from before the move is gone but the program is not.",
      },
      {
        id: "window-marked-elsewhere",
        text: "The first window still lists that workspace, dimmed with a window glyph; clicking it raises the other window instead of switching",
        hint: "The menu entry there reads “Show in Its Window”, never a second “Open in New Window”.",
      },
      {
        id: "window-edits-sync",
        text: "Renaming a page (or adding one) in one window shows up in the other's sidebar without a reload",
        hint: "config.json is shared; the writer broadcasts and every other window adopts. Check BOTH directions.",
      },
      {
        id: "window-close-returns",
        text: "Closing the workspace window asks nothing and hands the workspace back: the first window's row un-dims and switching to it works",
      },
      {
        id: "window-close-workspace",
        text: "Closing that workspace (sidebar X) from the first window takes its window down with it",
      },
      {
        id: "window-not-restored",
        text: "Quitting with two windows open and relaunching comes back as one window holding everything",
        hint: "Windows are deliberately not restored — the registry is ephemeral.",
      },
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
      {
        id: "hub-stats-agree",
        text: "The fleet strip's tabs / repos / cards / rails totals equal the sidebar's per-workspace strips added up",
        hint: "Cards fold by column NAME across boards, so two boards with a “To Do” each show one merged “TD”.",
      },
      {
        id: "hub-stats-shared-checkout",
        text: "Two workspaces opened on the SAME folder count as one repo in the strip, not two",
        hint: "Per-workspace tallies would double it; the fleet one dedupes by repoRoot.",
      },
      {
        id: "hub-running-lists-cards",
        text: "Running a card from a board makes it appear under its workspace in “Running tasks”, and stopping the agent removes it",
        hint: "The heading's count and the strip both come from fleetSummary — they must never differ.",
      },
      {
        id: "hub-running-phases",
        text: "An agent that asks a question moves to the top of its group with a red dot and “Waiting for you”",
        hint: "Order is waiting → interrupted → working → idle, then by title.",
      },
      {
        id: "hub-running-interrupted",
        text: "After a daemon restart, a card whose run was killed reads “Interrupted” with a hollow ring — never “Working”",
        hint: "The daemon's status describes the bare shell it put back, so the phase must be read from interruptedSessionIds first.",
      },
      {
        id: "hub-running-jumps",
        text: "A task row opens that card's detail modal in its own tab (Kanban, or Orchestration for a card on a rail); the terminal button lands on the running tab instead",
      },
      {
        id: "hub-running-loose",
        text: "A busy terminal you started by hand shows as “n busy agents with no card” under its workspace, and a quiet one shows nothing",
      },
      {
        id: "hub-two-columns",
        text: "Narrowing the window stacks the two columns instead of squashing them, and long card titles and root paths ellipse rather than widening the panel",
      },
      {
        id: "hub-inbox-quiet",
        text: "With nothing waiting, the hub shows one quiet line — “Nothing is waiting on you.” — above the two columns, with no panel, border or heading around it",
      },
      {
        id: "hub-inbox-three-reasons",
        text: "An agent asking a question, one the daemon marked failed, and a rail step whose turn ended with the card unmoved all appear in “Waiting on you”, each with its own badge",
        hint: "The badges are ui/indicators.ts's: a question mark for asking, a red octagon for failed, an enclosed pause for a turn that ended. A plain idle terminal must NOT appear — that is the case the list exists to exclude.",
      },
      {
        id: "hub-inbox-order",
        text: "Rows are ordered longest wait first, and the wait column ticks up when you close and reopen the hub",
        hint: "The clock is sampled once per render, not polled — reopening the hub is what re-samples it.",
      },
      {
        id: "hub-inbox-relaunch-bound",
        text: "After quitting with an agent waiting and relaunching, its row reads “since launch”, then “≥5m” and so on — never a plain “5m”",
        hint: "The daemon reports that a status changed, never when it began, so a status found already in place can only be a floor. A plain duration there would be a claim gavin cannot make.",
      },
      {
        id: "hub-inbox-jumps",
        text: "Clicking a row activates that workspace and lands on the waiting session's own tab; a row for a workspace's Home agent lands on its Home tab instead",
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
        id: "delete-lists-the-agent-file",
        text: "On an opencode workspace the skills screen is headed “Agent files” and lists .opencode/agent/gavin-commit.md alongside the four skills; answering Yes trashes it too",
        hint: "It is a whole file gavin wrote. Leaving it behind leaves the repo claiming a permission grant for a tool that is gone.",
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
  {
    // The suites cannot reach any of this: it needs a real agent, a real
    // network and a real machine suspend. The trigger table and the
    // budget ARE unit-tested (autoResume.test.ts) -- what is unverified
    // is everything downstream of a genuine interruption.
    title: "Auto-resume an interrupted run",
    items: [
      {
        id: "auto-resume-off-by-default",
        text: "A brand-new rail's Auto-resume button reads 'off', and Settings' 'Resume a broken card run by itself' is unchecked",
        hint: "Consent is given in advance or not at all. Every other toggle in Settings defaults ON; this one must not.",
      },
      {
        id: "auto-resume-card-run",
        text: "With the workspace setting on, break a card run's connection and watch it come back by itself within a minute",
        hint: "Point the agent at an unreachable ANTHROPIC_BASE_URL mid-turn — the reproducible version of pulling the network.",
      },
      {
        id: "auto-resume-keeps-context",
        text: "The resumed agent CARRIES ON — it knows what it was doing, rather than starting the card over",
        hint: "This is the whole point. A resume that silently begins again is the from-scratch second attempt wearing a better name.",
      },
      {
        id: "auto-resume-notifies",
        text: "An OS notification says it broke and was resumed, naming the agent's own error line",
        hint: "A resume that leaves no trace is indistinguishable from a run that never failed.",
      },
      {
        id: "auto-resume-trail-on-card",
        text: "The card detail modal shows 'Recovered on its own: …' with the times, and still says something after a window reload",
        hint: "The times live in memory; the COUNT is persisted, so after a reload the line is shorter but still there.",
      },
      {
        id: "auto-resume-only-once",
        text: "Break the SAME run a second time — gavin does not resume it again, and says why",
        hint: "One automatic attempt per run. If it resumes twice, the budget is not surviving the write.",
      },
      {
        id: "auto-resume-never-on-login",
        text: "An expired token (an agent asking for /login) is NOT resumed; the notification says so",
        hint: "Resuming loops against a wall. This is the case a naive 'retry when something broke' gets wrong.",
      },
      {
        id: "auto-resume-rail-sequence",
        text: "Turn a rail's Auto-resume on, break its running step in a SEQUENCE stage, and watch the step and the rail both come back",
        hint: "The rail is paused by the stall; a resumed step on a paused rail would finish and advance nothing.",
      },
      {
        id: "auto-resume-parallel-stalls",
        text: "A two-step PARALLEL stage broken by ONE interruption stays stalled, and says both steps broke together",
        hint: "This is the deliberate refusal. Putting both back returns each agent to a checkout its sibling had moved on from.",
      },
      {
        id: "auto-resume-lid-closed",
        text: "Start a two-step parallel stage, close the lid mid-run, reopen on a DIFFERENT network — and check what happened to both steps and to the checkout they share",
        hint: "The originating case, and the one thing no test can stand in for. Report what actually happened, including anything the design did not predict.",
      },
      {
        id: "auto-resume-commit-retry",
        text: "Break a 'Commit via agent' run's connection: it re-runs once by itself, and an ordinary refusal ('no user.email') does not",
        hint: "A retry, not a resume — a headless run exits and holds no conversation.",
      },
    ],
  },
  {
    title: "Alerts & confirms",
    items: [
      {
        id: "dialog-not-native",
        text: "Closing a terminal tab asks in a gavin modal — themed panel, monospace, dimmed backdrop — not a macOS sheet",
        hint: "The whole section: no prompt in the app should be drawn by the OS any more.",
      },
      {
        id: "dialog-says-the-verb",
        text: "Every prompt's buttons name the action: Close tab / Close pane / Close page / Close tabs / Remove workspace / Archive card — never OK",
      },
      {
        id: "dialog-enter-and-escape",
        text: "Enter takes the harmless answer and Escape always dismisses: Enter closes the tab, but on “Remove this workspace” and “Archive this card” Enter cancels instead",
        hint: "Destructive prompts keep focus on the dismissing button on purpose.",
      },
      {
        id: "dialog-stacked-escape",
        text: "Deleting a card from its detail modal: one Escape closes only the confirm, and the card detail is still open behind it",
        hint: "Both are window-level Escape listeners — this is the one that used to close both.",
      },
      {
        id: "dialog-alert-one-button",
        text: "A failing menu action (rename a page to something the daemon rejects, or Show in Finder on a deleted folder) shows a one-button gavin modal, not a red macOS alert",
      },
      {
        id: "dialog-window-close",
        text: "The red traffic light asks “Close this window?” with Close window / Keep open, and Keep open really keeps it",
        hint: "⌘W closes a tab, not the window — use the button, or ⌘Q.",
      },
      {
        id: "dialog-reclaim-two-actions",
        text: "The removed-folder reclaim offers Restore / Start fresh — neither says Cancel, because both spend the saved board",
      },
      {
        id: "dialog-queue",
        text: "Two failures in a row show one modal at a time: dismissing the first reveals the second rather than losing it",
      },
    ],
  },
  {
    // Everything here needs a real subscription, a real clock and a real
    // machine suspend. The phase arithmetic, the bands and the gate ARE
    // unit-tested (agentPause.test.ts, agentUsage.test.ts); what no suite
    // can reach is whether the numbers on screen match the ones the agent
    // itself reports, and whether a lid closing does what the module
    // claims it does.
    title: "Agent limits & usage",
    items: [
      {
        id: "usage-panel-matches-agent",
        text: "Sidebar → Usage shows Claude Code's 5-hour and weekly bars, and the percentages match what /usage says inside Claude Code",
        hint: "The one check that matters. A bar that disagrees with the agent is worse than no bar — if they differ, note both numbers.",
      },
      {
        id: "usage-unsupported-is-a-sentence",
        text: "A workspace on Gemini, Cursor or opencode gets a sentence saying gavin cannot read its limits — not an empty bar or a 0%",
        hint: "Absence is never zero. 'gavin cannot see' must never render like 'plenty left'.",
      },
      {
        id: "usage-refresh-and-backoff",
        text: "The refresh button re-reads; hammering it does not produce a wall of errors",
        hint: "The host caches for two minutes and parks itself for fifteen on a 429. If you can get it into a persistent 429, say so — that endpoint is known to be touchy.",
      },
      {
        id: "usage-codex-age",
        text: "With Codex in use, the panel shows its windows AND says how old the reading is",
        hint: "Codex's numbers come from its last turn, not from now. A number with no age on it would read as live.",
      },
      {
        id: "pause-off-by-default",
        text: "An existing workspace shows Agent pause OFF in Settings, and nothing pauses after the update",
        hint: "Stored as absence. A workspace that starts pausing because it was updated is the failure this default exists to prevent.",
      },
      {
        id: "pause-cycle-holds-a-rail",
        text: "Set a short cycle (period 15, pause 7), start a rail, and watch the next step NOT launch during the pause window",
        hint: "The pause is the TAIL of each period. The sidebar Usage row should read 'Paused' with the reason in its tooltip.",
      },
      {
        id: "pause-leaves-running-work-alone",
        text: "An agent already mid-turn when the pause begins finishes normally — it is not interrupted or killed",
        hint: "A pause that kills work in flight is not a pause. This is the decision the feature was built around.",
      },
      {
        id: "pause-manual-run-still-works",
        text: "While paused, your own Run on a card still starts an agent",
        hint: "The gate is on gavin starting work, not on you. The human keeps the wheel.",
      },
      {
        id: "pause-lifts-and-rail-continues",
        text: "When the pause window ends, the held step launches by itself within a minute or so",
        hint: "This IS 'resume'. Nothing is armed for it — the next tick recomputes the phase from the wall clock.",
      },
      {
        id: "pause-survives-sleep",
        text: "With a cycle running, close the lid for longer than a whole period and reopen: the phase is right for the CURRENT time, not shifted by however long it slept",
        hint: "The originating requirement. A wrong answer here means something is counting down instead of reading the clock.",
      },
      {
        id: "pause-survives-restart",
        text: "Quit and relaunch the app mid-cycle: the pause window falls at the same wall-clock times as before",
        hint: "The anchor is persisted and never rewritten. If the pause moved, a save site is re-stamping it.",
      },
      {
        id: "pause-workspace-override",
        text: "A workspace with its own settings ignores the app-wide cycle; unticking 'own settings' puts it back to inheriting",
        hint: "Absent means INHERIT, not off. A workspace switched off stores enabled:false — check config.json if in doubt.",
      },
      {
        id: "pause-limit-hold",
        text: "Set the limit threshold below your current usage and confirm rails hold with 'At limit' and the real reset time",
        hint: "Easiest with the weekly window. The reason should name the window and its reset, not just say 'paused'.",
      },
      {
        id: "pause-defers-auto-resume",
        text: "With auto-resume on, break a run DURING a pause window: the resume waits for the pause instead of being cancelled",
        hint: "A pause defers a resume. If the run is skipped outright and never comes back, the deferral is not re-arming.",
      },
      {
        id: "wizard-offers-pause",
        text: "The init wizard's agent step offers the pause, unticked, and ticking it makes Settings show the same cycle",
        hint: "The wizard writes the APP-wide cycle, not a workspace override.",
      },
    ],
  },
  {
    title: "Badges & indicators",
    items: [
      {
        id: "badge-no-bare-dots",
        text: "No coloured dot anywhere carries a meaning on its own: every badge is a glyph, and hovering it names its axis first (“Agent · …”, “Priority · …”, “Git · …”)",
        hint: "The point of the whole section. If you meet a dot you have to guess about, that is the bug.",
      },
      {
        id: "badge-priority-ramp",
        text: "A card's priority is a signal-bar ramp, and medium and high are visibly different",
        hint: "They used to be the SAME amber dot. Set four cards to low / medium / high / urgent and look at them side by side.",
      },
      {
        id: "badge-priority-low-visible",
        text: "A low-priority card's badge is actually visible on the card, in both themes",
        hint: "It used to be painted in --surface-success, a near-black tint, so it simply was not there.",
      },
      {
        id: "badge-agent-one-vocabulary",
        text: "One running agent looks the same in all four places at once: its board card, its terminal tab, its sidebar row, and the card's detail modal",
        hint: "Run a card, then put the board and the terminal side by side. Working spins; waiting is an amber question mark; idle is a dashed ring.",
      },
      {
        id: "badge-waiting-is-amber",
        text: "An agent waiting on you is amber everywhere — badge, card spine, the sidebar's page and workspace counts, the hub tab's corner pip",
        hint: "The counts used to be filled red while the row below them was amber for the same fact. Red is now only for broken and for urgent.",
      },
      {
        id: "badge-tab-bar-three-axes",
        text: "A terminal tab can show three badges at once and each is readable: a spinning agent, a branch glyph for the checkout, a pencil for unsaved edits",
        hint: "Open a file tab with an unsaved edit beside a running agent in a dirty repo. These were three near-identical dots.",
      },
      {
        id: "badge-git-clean-is-quiet",
        text: "A clean checkout's branch glyph is muted, not an amber ring — on the tab bar and in the sidebar's expanded tab rows",
      },
      {
        id: "badge-sidebar-one-branch-glyph",
        text: "An expanded page's tab row shows ONE branch glyph, toned with the branch name beside it, not a glyph plus a separate dot",
      },
      {
        id: "badge-reduced-motion",
        text: "With System Settings → Accessibility → Display → Reduce motion on, the working badge stops spinning but stays blue and readable",
      },
      {
        id: "badge-step-states-visible",
        text: "On a rail, every step chip shows a square saying where the rail has got to — empty for pending, a filled centre for the one running now, a tick for done, a cross for stalled",
        hint: "Pending and running used to draw NO glyph at all: running was an accent ring and nothing else. Look down a part-run rail — the squares should read as a progress column.",
      },
      {
        id: "badge-step-chip-matches-card",
        text: "The same step says the same thing on its chip and on its board card — same square, same colour, the card just spells the word out too",
        hint: "Switch the rail between chip and card view with one step running. The card used to say “running” in blue text with no glyph while the chip said it with a blue ring and no word.",
      },
      {
        id: "badge-step-vs-agent",
        text: "A running step whose agent is waiting on you shows BOTH marks side by side: the accent square for the rail, the amber question mark for the agent — and only one of them, the agent's, is a spinner's neighbour",
        hint: "Two different questions. The step is still running, which is why the rail has not stopped; the agent is the thing standing still.",
      },
      {
        id: "badge-rail-state",
        text: "A rail's own state badge matches in its header and in the Home hub's rail list — a dash for idle, a doubled chevron for running, a pause for paused",
        hint: "The two surfaces kept private copies of the same three colours. Start and pause a rail with Home open beside it.",
      },
      {
        id: "badge-chevrons-sharp",
        text: "The running rail's doubled chevron keeps its points at 11px — not two blunt smudges",
        hint: "It is cut with the same miter join theme.css gives the disclosure chevrons. Compare it against a sidebar disclosure arrow.",
      },
      {
        id: "badge-both-themes",
        text: "Every badge above still reads in the light theme — especially amber-on-white, the priority ramp, and the step squares against a chip's severity fill",
      },
    ],
  },
  {
    title: "Tooltips",
    items: [
      {
        id: "tooltip-tab-label-not-clipped",
        text: "Hovering a tab's name shows its full hover text in one piece — nothing sliced off by the tab strip's top edge",
        hint: "The tab bar scrolls, so its overflow clips anything drawn inside it. Use the TOP pane of a split, where there is no room above the strip: the bubble should flip below the tab rather than be cut.",
      },
      {
        id: "tooltip-tab-label-says-something",
        text: "That text is the thing the label had to shorten: a terminal's session name or cwd, a file tab's full path, a board tab's context folder",
      },
      {
        id: "tooltip-tab-card-link",
        text: "The ↗ on an agent tab names the card it opens, and the bubble looks identical to the badges' beside it",
        hint: "One tooltip, one look. If this one is a different box from the git badge's two pixels away, a second mechanism has come back.",
      },
      {
        id: "tooltip-drag-leaves-none",
        text: "Dragging a tab by its name leaves no bubble behind",
      },
    ],
  },
  {
    title: "Orchestration with no rails",
    items: [
      {
        id: "orch-no-rails-drawer-shown",
        text: "On a workspace with no rails the Orchestration tab still shows the Unplaced drawer at its right edge — its cards live, its Groups and Tools listed but greyed — and “No rails yet” stands in the empty strip beside it",
        hint: "Delete every rail, or open a fresh workspace. Before this the whole lower half was that one line and the drawer — the list a first rail is built from — was nowhere. The drawer's hint should read “No rail to place these on yet — add one with “+ Rail””.",
      },
      {
        id: "orch-no-rails-drawer-inert",
        text: "With no rails, no drawer row drags and no tool or group row click-adds; press “+ Rail” and the same rows light up, click a tool onto the new rail and drag onto it",
        hint: "Pressing and moving on a card row must show no drag ghost — the rows carry no drag handle at all in this state, not merely a disabled look. A card row still CLICKS, though: it opens the card, which needs no rail. The new rail is the drawer's click-to-add target for tools and groups the moment it exists.",
      },
    ],
  },
  {
    title: "Opening a card from the Unplaced drawer",
    items: [
      {
        id: "orch-drawer-click-opens",
        text: "Clicking a card row in the Orchestration tab's Unplaced drawer opens that card's detail modal — and places nothing on any rail",
        hint: "It used to append the card to whichever rail was first, a target the row never named. Check the rails after the press: no new step anywhere. The modal is the board's own — same columns, same labels, same nested children — so an edit made in it shows on the Kanban tab too.",
      },
      {
        id: "orch-drawer-click-still-places",
        text: "Placement still works both ways: drag a card row onto the rail you mean, or use that rail's “+ Add step”; a Tools or Groups row still appends on a click",
        hint: "The drawer's hint says which is which: “Drag onto a rail. Click a card to open it, a tool to append it.” A press-and-move on a card row must still raise the drag ghost — opening on click cannot have cost the row its drag.",
      },
      {
        id: "orch-drawer-click-no-rail",
        text: "On a workspace with no rails a card row still opens its modal, while the Tools and Groups rows stay greyed and inert",
        hint: "Reading a card needs no rail; appending one does. The card row must not look or behave disabled here even though nothing can be placed yet.",
      },
      {
        id: "orch-drawer-click-follows-edit",
        text: "Moving that card to Done from the modal drops it into the drawer's collapsed Done group and out of the “Unplaced (n)” count, with the modal still open",
        hint: "The row and the modal read one projection. If the row stays put in its old group, the drawer is holding a snapshot rather than the board's live cards.",
      },
    ],
  },
  {
    title: "Proposed memories",
    items: [
      {
        id: "memory-adopt-offered",
        text: "A `kind: note` card labelled `memory` shows “Adopt into CLAUDE.md” in the detail modal's action row; the same label on a task or plan shows nothing",
        hint: "The button is named for the workspace's own instructions file — on a workspace whose agent is codex it must read “Adopt into AGENTS.md”. The label comes off the card's frontmatter (`labels: memory`); the modal's label chip toggles it wherever the board's vocabulary carries `memory`.",
      },
      {
        id: "memory-adopt-writes",
        text: "Pressing it appends the card body as a bullet under a “### Learned” heading INSIDE CLAUDE.md's <!-- gavin:start --> block, and the card lands in the board's last column",
        hint: "The body's second line (“Why: …”) rides along indented under the same bullet. Nothing opens — no editor, no tab, and the modal stays put; check the file on disk. Pressing Adopt on a second memory adds a bullet under the SAME heading.",
      },
      {
        id: "memory-survives-setup",
        text: "Settings → agent → “Set up / update” rewrites the gavin block and the “### Learned” bullets are still inside it, unchanged",
        hint: "This is the whole reason the section lives inside the markers. Change the agent profile first so the block's text visibly differs afterwards — the guidance above the heading should be new, the bullets below it identical.",
      },
    ],
  },
  {
    title: "Per-run changes",
    items: [
      {
        id: "run-changes-tab-chip",
        text: "Run a card in a repo, let its agent edit a file, then press the diff glyph on its tab: the modal lists what THAT run changed, from the commit it started on",
        hint: "The glyph sits beside the ↗ card link and only appears on a tab whose run has a baseline. The list must include files the agent already committed — that is the whole difference from the Git tab.",
      },
      {
        id: "run-changes-untracked-counted",
        text: "A run that only CREATES files still shows a file count and a “+N” — not “+0 −0”",
        hint: "Untracked files are counted by reading them; a new 3-line file is +3. “+0” here would read as “this agent did nothing”.",
      },
      {
        id: "run-changes-card-modal",
        text: "The same run opens from the card detail modal's Agent session section, under the run buttons, and says “Changes since <sha>”",
      },
      {
        id: "run-changes-no-baseline-says-why",
        text: "A card bound by an older run (or one launched outside a repository) shows a SENTENCE in that spot, never a button that would diff against nothing",
        hint: "Unlink and re-run the card to get a baseline back. Against a v25 daemon the sentence should name the daemon version instead.",
      },
      {
        id: "run-changes-discard-refuses-live",
        text: "With the agent still running, “Discard this run…” is disabled and hovering it explains that stopping the agent comes first",
        hint: "The reason hangs on the span around the button — a disabled button fires no mouseenter.",
      },
      {
        id: "run-changes-discard-restores",
        text: "Stop the agent, discard the run, and the checkout goes back: its commits are off the branch, its edits reverted, and the files it created are in the Trash — draggable back out",
        hint: "Confirm the dialog listed all three before you pressed it. `git reflog` should still show the dropped commits; the Trash should hold the new files rather than nothing.",
      },
      {
        id: "run-changes-discard-git-tab",
        text: "The Git tab, open on the same checkout, shows the reset without being touched",
        hint: "Its own `git-changed` watcher, not a call from the run view.",
      },
    ],
  },
  {
    title: "Per-card run history",
    items: [
      {
        id: "run-history-lists-every-run",
        text: "Run a card, let it finish, re-launch it, then open “Run history…” in the card modal: BOTH runs are listed, newest first",
        hint: "This is the whole feature. Before v27 the daemon kept one binding per card and the earlier run was overwritten — one row here means the history is not being kept.",
      },
      {
        id: "run-history-resume-is-one-run",
        text: "Resume a card and its resumed session appears INDENTED under the run it continues, labelled “resume 1” — the card still counts as one run",
        hint: "A resume launches a new session carrying the old conversation id. Two top-level rows here would tell you that you ran the card twice when you pressed Resume once.",
      },
      {
        id: "run-history-tokens-per-run",
        text: "Each run shows a token cost (“438k tokens · 14 turns”), and hovering it gives the exact input/output/cache split",
        hint: "Read out of ~/.claude/projects/<dir>/<conversation id>.jsonl. Sanity-check the magnitude against `/usage` in the same conversation — a figure roughly THREE times too big means the per-content-block duplicate records are being counted more than once.",
      },
      {
        id: "run-history-live-run-ticks",
        text: "With an agent still working, its row says “Running”, its duration counts up second by second, and its token figure grows on Refresh",
        hint: "A frozen number on the row somebody is actually watching is the failure mode here.",
      },
      {
        id: "run-history-unwatched-run-has-no-duration",
        text: "A run interrupted by a daemon restart shows “Unwatched” and an em dash for its duration — never a duration counted from its start to now",
        hint: "Force it: launch a card, restart the daemon, reopen the history. A multi-hour duration on a run that lasted two minutes is the bug this row exists to catch.",
      },
      {
        id: "run-history-cost-absent-not-zero",
        text: "A run with no readable transcript (a gemini or opencode profile, or one whose log was deleted) says “No cost recorded” with a reason on hover — never “0 tokens”",
      },
      {
        id: "run-history-open-session",
        text: "“Open session” on a run whose session is still around jumps to that terminal",
      },
      {
        id: "run-history-reaches-an-unbound-card",
        text: "Unlink a card that has been run, reopen its modal: “Run history…” is still there, and the run it just lost is listed as “Unbound”",
        hint: "The history sits outside the bound/unbound split — a card whose binding is gone is exactly the one whose history somebody wants.",
      },
      {
        id: "run-history-old-daemon-blames-itself",
        text: "Against a daemon older than v27 the “Run history…” button is disabled and the hover says the DAEMON only started keeping history in v27",
        hint: "The sentence must be about gavin, not about the card. “No runs” on a card the human watched an agent work is the misreading this guards.",
      },
    ],
  },
  {
    title: "Files tab",
    items: [
      {
        id: "files-tree-opens-over-the-root",
        text: "The Files tab opens with the workspace root's own row expanded and its top level listed — dotfiles, target/ and node_modules/ included",
        hint: "The tree shows everything on disk on purpose: no .gitignore filter and no dotfile rule. A missing .gitignore or a missing target/ means something is filtering that was never meant to.",
      },
      {
        id: "files-large-dir-stays-responsive",
        text: "Expanding node_modules/ (or target/) lists it without the window stuttering, and expanding it a second time after collapsing is instant",
        hint: "One read_dir per opened directory, no recursive walk and no watcher on the repo tree — the 3000-folder FSEvents stall is exactly what this shape avoids. The second open is instant because a collapse keeps the listing.",
      },
      {
        id: "files-symlink-is-a-leaf",
        text: "A symlink is listed with a link glyph, no chevron, and clicking it does not walk into it",
        hint: "The host reports a link's kind from symlink metadata, so a link to a directory is never a directory here.",
      },
      {
        id: "files-click-opens-in-the-pane",
        text: "Clicking a .ts/.md/.rs file opens it in the editor pane on the right, editable",
      },
      {
        id: "files-binary-opens-in-the-os",
        text: "Clicking a .png (or any type outside viewable_extensions) opens it in the OS's default app and leaves the editor pane alone — and its menu entry reads “Open in the default app”",
        hint: "The PRD's standing rule for binaries and media. The label saying so before the click is the point: nobody should have to click to find out it leaves the app.",
      },
      {
        id: "files-open-in-a-tab",
        text: "“Open in a tab” on a file row opens it as a file tab beside the focused terminal",
        hint: "Needs a terminal session focused to anchor the split; with a file or board tab focused the entry is absent rather than dead.",
      },
      {
        id: "files-copy-path-and-reveal",
        text: "“Copy path” puts the absolute path on the clipboard, and “Reveal in Finder” selects the entry in its folder",
      },
      {
        id: "files-new-file-and-folder",
        text: "“New file…” and “New folder…” on a folder row create it in place; the new file opens in the editor pane and the new folder opens empty",
        hint: "Creating into a folder never opened before must work too — the tree reads it rather than inventing a listing.",
      },
      {
        id: "files-create-refuses-to-clobber",
        text: "Creating a file whose name is already taken refuses with “already exists” and leaves the existing file untouched",
      },
      {
        id: "files-rename-in-place",
        text: "Rename a folder that has open subfolders inside it: the row renames and the subfolders STAY open",
        hint: "The tree re-keys the subtree instead of re-reading it. Folders folding shut on the human's own rename is the failure this catches.",
      },
      {
        id: "files-rename-follows-an-open-tab",
        text: "With a file open as a tab, rename it from the Files tab: the tab's title follows, its editor keeps showing the file, and no “deleted” banner appears",
        hint: "Retargeting, not remounting. A file reappearing at the OLD name afterwards means the editor's last-chance write landed on the path that had just stopped existing.",
      },
      {
        id: "files-trash-asks-first",
        text: "“Move to Trash” asks in gavin's own dialog — never a macOS one — with a red button, focus left on Cancel, and the folder case saying it takes everything inside",
        hint: "plugin-dialog is capability-narrowed; a native confirm fails at the permission layer instead of appearing.",
      },
      {
        id: "files-trash-keeps-the-buffer",
        text: "Trash the file the editor pane is showing WITH unsaved edits: the pane keeps the text under its “deleted” banner rather than clearing",
        hint: "That buffer is the only copy left. Tidying the pane would throw it away.",
      },
      {
        id: "files-trash-is-recoverable",
        text: "A trashed file is in the Finder Trash and can be put back — never gone",
      },
      {
        id: "files-filter-keeps-ancestors",
        text: "Typing in the filter box narrows to matching names and keeps each match's parent folders visible above it",
      },
      {
        id: "files-filter-empty-state-says-loaded-only",
        text: "A filter matching nothing says “No match in the folders you have opened” — never a bare “No match”",
        hint: "The filter only ever sees loaded nodes; walking the repo to find the rest is the trap the lazy tree exists to avoid. The wording is the honest difference between “not in this repo” and “open the folder it is in”.",
      },
      {
        id: "files-selection-survives-a-tab-switch",
        text: "Open a file three folders deep, switch to Kanban and back: the same folders are open and the same file is in the editor",
        hint: "The hub view is destroyed on every switch, so this comes back out of localStorage, per workspace.",
      },
      {
        id: "files-restored-selection-verified",
        text: "Delete the remembered file outside gavin, then return to the Files tab: the pane opens empty rather than on a phantom",
        hint: "The restore is verified against the tree — but only once the containing folder has actually been read.",
      },
      {
        id: "files-split-is-a-share",
        text: "Drag the divider, then resize the window: the two panes keep their proportion and neither collapses; double-click resets it",
      },
      {
        id: "files-refresh-catches-up",
        text: "Have an agent write a file into an open folder, then press Refresh: the new file appears and the open folders stay open",
        hint: "There is deliberately no watcher on the repo tree, so nothing appears until Refresh — that is the design, not a bug.",
      },
    ],
  },
  {
    title: "Nested tasks and Done",
    items: [
      {
        id: "completion-drag-to-done-asks",
        text: "Drag a plan carrying two nested tasks into Done: gavin asks first, names both tasks by title, and says plans/done/ takes their files too",
        hint: "The prompt is the whole fix. A plan whose own checklist is complete can still be carrying untouched follow-on work, and nothing else on the board can say so — a nested task has no status of its own to look unfinished with.",
      },
      {
        id: "completion-box-left-alone-files-everything",
        text: "Answer that prompt with the box left alone: the plan and both tasks land in Done, exactly as before",
        hint: "The default has to stay what the app has always done. The prompt exists to make the sweep loud, not to reverse it.",
      },
      {
        id: "completion-box-ticked-keeps-them",
        text: "Do it again with the box ticked: the plan files, and both tasks appear as their own cards in the first column, each still showing “Part of” the plan",
        hint: "Break-out is one status: write. Losing the parent link would be “Un-parent”, which is a different action and stays a different action.",
      },
      {
        id: "completion-cancel-snaps-back",
        text: "Cancel the prompt: the card returns to the column it was dragged from with nothing written, and no placeholder is left behind in Done",
        hint: "The question is asked before the drop is held, so the board must never show the drop as already made while the modal is up.",
      },
      {
        id: "completion-asked-on-every-route",
        text: "The same prompt appears from the card menu's “Move to Done”, the detail modal's Status select, a rail header's “Move all to Done” and the Plans tab's Status select — and both selects snap back on Cancel",
        hint: "Four gestures, one question. A select still reading “Done” after a cancel is the modal lying about where the card is.",
      },
      {
        id: "completion-tasks-list-breaks-one-out",
        text: "Open a plan's card: the Tasks list says a nested task has no status of its own, and “Break out” beside a nested child moves it to the first column while it keeps the link back",
      },
      {
        id: "completion-conflict-repairs-itself",
        text: "Put a nested child on a rail beside its parent: the conflicts box's “Break out” button clears the pair without either step leaving its rail",
        hint: "The escape offered where the complaint is. Taking one step off a rail was the only advice this row used to be able to give.",
      },
    ],
  },
  {
    title: "Card panes from a terminal tab",
    items: [
      {
        id: "cardpane-show-plan-splits",
        text: "Run a card, then click the ☑ chip on its terminal tab: the card's detail panel opens as a pane to the RIGHT, with the terminal still on screen beside it",
        hint: "This chip used to be an arrow that switched the whole window to the Kanban or Orchestration tab. Watching an agent and reading its card are the same act; taking the terminal away to do the second was the bug.",
      },
      {
        id: "cardpane-show-plan-once",
        text: "Click that same chip again: nothing splits — the pane already open comes forward instead",
        hint: "The chip is clicked repeatedly by anyone checking on a run. Splitting per click is how a page ends up four copies deep in one card.",
      },
      {
        id: "cardpane-go-to-board",
        text: "The plan pane's header carries “Show on the board”, and it lands on the card's own hub tab — the Orchestration tab for a railed card, Kanban for any other",
        hint: "The old chip's jump did not disappear, it moved one click in. Check BOTH kinds of card: a railed one must not land on the board.",
      },
      {
        id: "cardpane-no-go-to-board-on-the-hub",
        text: "Open the same card from the Kanban tab: the modal there has NO “Show on the board” button",
        hint: "It would go where it already is. The action is passed per host, so only the pane offers it.",
      },
      {
        id: "cardpane-changes-splits-too",
        text: "The ⑂ Changes chip splits the diff in as a pane as well, no longer as a modal over the terminal",
      },
      {
        id: "cardpane-both-views-coexist",
        text: "Open the plan pane and the changes pane for one card: they are two tabs, not one that keeps swapping",
      },
      {
        id: "cardpane-escape-does-not-close-it",
        text: "With a card pane focused, press Escape: the pane stays. Clicking the terminal beside it does not close it either",
        hint: "The panel is the card detail component drawn inline. If it still behaved like a dialog it would vanish on the Escape meant for the terminal.",
      },
      {
        id: "cardpane-tasks-list-moves-only-this-pane",
        text: "Open a plan's pane AND its changes pane, then click a nested task in the Tasks list: only the plan pane follows",
        hint: "Navigating within a pane and following a card whose FILE moved are two different writes.",
      },
      {
        id: "cardpane-done-follows-the-file",
        text: "Set the card Done from inside the pane: it files into plans/done/ and the pane follows it there rather than reading “No card at …”",
      },
      {
        id: "cardpane-survives-a-restart",
        text: "Leave a card pane open and restart the app: it comes back as the same card pane — NOT as a terminal, and no extra shell is spawned",
        hint: "The dangerous one. A tab id in a layout tree that no tab map claims is treated as a dead session and replaced by a fresh shell, so a card tab that failed to persist would not go missing quietly.",
      },
      {
        id: "cardpane-closes-without-killing",
        text: "Close a card pane: no confirm about ending a terminal session, and the sidebar's page expansion drops its row",
        hint: "A card pane runs no process. The close prompt saying “The terminal session will end” would be a lie.",
      },
      {
        id: "cardpane-sidebar-row",
        text: "The sidebar's page expansion lists a card pane with the ☑ glyph and the label “<card> · plan” / “<card> · changes”, matching the tab bar exactly",
      },
      {
        id: "cardpane-archive-closes-it",
        text: "Archive a card that has a pane open: the pane closes with it, like its file tabs already did",
      },
    ],
  },
  {
    title: "Cut and copy a line",
    items: [
      {
        id: "lineclip-compose-body-copy",
        text: "In the ⌘N composer's body, type three lines, put the caret in the middle one with NOTHING selected, press ⌘C, then ⌘V at the end — the whole middle line arrives, on a line of its own",
        hint: "Nothing selected used to mean the keystroke did nothing at all. The pasted text must carry its line break, or the round trip joins two lines into one.",
      },
      {
        id: "lineclip-compose-body-cut",
        text: "Same box, caret in the middle line, ⌘X: the line AND its break go, so no blank line is left behind and the caret sits at the start of the line that moved up",
      },
      {
        id: "lineclip-undo",
        text: "Straight after that ⌘X, press ⌘Z: the cut line comes back",
        hint: "The delete goes through the field's own editing command for exactly this reason. A hand-written value assignment would leave nothing to undo.",
      },
      {
        id: "lineclip-last-line",
        text: "⌘X on the LAST line of a multi-line box removes it without leaving a trailing blank line",
      },
      {
        id: "lineclip-selection-untouched",
        text: "Select a few characters and press ⌘C: just that selection is copied, exactly as before",
        hint: "The line gesture may only fill the gap where the selection is empty.",
      },
      {
        id: "lineclip-single-line-field",
        text: "In a one-line field (the composer's title, a search box), ⌘C with no selection copies the whole field — and pasting it into a terminal does NOT submit it",
        hint: "No trailing break on a single-line field, deliberately: a search query that ends in a newline runs itself the moment it lands at a shell prompt.",
      },
      {
        id: "lineclip-single-line-cut",
        text: "⌘X in that one-line field clears it, and the surface reacts — the Add button disables, the search results come back",
        hint: "Proves the edit reaches Svelte's binding rather than only the DOM node.",
      },
      {
        id: "lineclip-file-editor",
        text: "In a file tab's Edit mode, ⌘X with no selection cuts the caret's line; ⌘V puts it back as a line",
        hint: "The editor already did this on its own. The pass is to confirm nothing added here got in its way.",
      },
      {
        id: "lineclip-terminal-untouched",
        text: "With a terminal focused, select output and ⌘C: the selection copies. With nothing selected, ⌘C does NOT paste a stray line anywhere",
        hint: "The terminal answers the copy itself with its own selection; the line gesture must never speak over it.",
      },
      {
        id: "lineclip-readonly",
        text: "In a read-only text box, ⌘X copies the line but leaves the text alone",
      },
    ],
  },
  {
    title: "Sidebar rework",
    items: [
      {
        id: "sidebar-gavin-footer",
        text: "“Gavin” is the FIRST row of the sidebar's footer, above Task manager / Usage / Settings, with a short rule under it that does not reach either edge",
        hint: "It used to sit above the workspace list. Clicking it still opens the app hub, and the row fills while the hub is up.",
      },
      {
        id: "sidebar-no-workspaces-header",
        text: "There is no “Workspaces” heading row and no + on it — the list starts at the first workspace",
      },
      {
        id: "sidebar-collapse",
        text: "The strip over the sidebar has a collapse button on the far side from the traffic lights; clicking it narrows the column to an icon rail — it never disappears",
        hint: "The traffic lights live in that same column, so a hidden sidebar would be a window with no controls. The rail is as wide as the controls need and no wider.",
      },
      {
        id: "sidebar-collapse-rows",
        text: "Collapsed, each workspace is one row showing its initial, its accent stripe and its active fill; hovering names it in full, clicking switches to it, right-click still opens its menu",
      },
      {
        id: "sidebar-collapse-persists",
        text: "Collapsed, reload the frontend (⌘R) — it comes back collapsed, and the expand button puts it back",
        hint: "localStorage, like the row expansion beside it. A reload used to be the only way to lose it.",
      },
      {
        id: "sidebar-open-workspace",
        text: "The folder button on that strip opens a picker; choosing a folder that already holds .gavin* makes a workspace named after the folder and binds it in one step",
      },
      {
        id: "sidebar-open-workspace-fresh",
        text: "Choosing a folder with no .gavin* asks Initialize / Open without initializing / Cancel — and Cancel leaves NO new workspace behind",
        hint: "The old sidebar + created the workspace first and asked afterwards, which is how a nameless rootless row got left on every escape.",
      },
      {
        id: "sidebar-open-workspace-already",
        text: "Picking a folder a workspace is already on switches to that workspace instead of building a second one on the same root",
      },
      {
        id: "sidebar-search-row",
        text: "The magnifier opens a search box as the sidebar's second row, focused and ready to type; Escape, the ✕, or the magnifier again closes it AND clears what was typed",
      },
      {
        id: "sidebar-search-order",
        text: "Type a word several things share: matching workspaces come first, then pages, then sessions — never interleaved",
        hint: "The ranking is the feature. Seed it by naming a workspace, one of its pages and a terminal in it the same thing.",
      },
      {
        id: "sidebar-search-open",
        text: "Clicking a hit lands on it — a workspace switches, a page opens, a session gets focus in its page — and the search row closes behind you",
      },
      {
        id: "sidebar-scratchpad-off",
        text: "Settings → Sidebar → untick “Keep its row in the sidebar”: the Scratchpad row goes, and ⌘⌥1 now means the FIRST remaining workspace",
        hint: "The sidebar and the shortcut read one ordering on purpose. If the digits are off by one, they have stopped sharing it.",
      },
      {
        id: "sidebar-scratchpad-off-while-in-it",
        text: "Switch to the Scratchpad first, THEN untick it: the app moves you to another workspace rather than leaving you on one with no row",
      },
      {
        id: "sidebar-scratchpad-back",
        text: "Tick it again: the row is back, with every page that was in it",
        hint: "Nothing is closed or deleted by switching it off — only the row goes.",
      },
      {
        id: "sidebar-cards-badge-quiet",
        text: "Hover the card-count badge on a workspace's recap strip: a tooltip names every column, and the strip does NOT rearrange itself — git and rails stay put",
        hint: "It used to take over the whole row after 250ms of hover. Crossing the strip on the way elsewhere is far more common than wanting the breakdown.",
      },
    ],
  },
  {
    title: "Hub tab strip",
    items: [
      {
        id: "hubtabs-locked-by-default",
        text: "A tab cannot be dragged until the ⇄ button at the end of the row is clicked",
        hint: "Locked is the resting state, and it is not remembered: reopening the app locks the row again.",
      },
      {
        id: "hubtabs-drag-reorder",
        text: "Unlocked, dragging a tab shows an insertion mark on the tab under the cursor and drops it there",
        hint: "The mark is the pane tab row's own — a 2px bar on the leading or trailing edge.",
      },
      {
        id: "hubtabs-digits-follow",
        text: "After a reorder, ⌘1…⌘8 open the tabs in their NEW positions, and the badges shown while ⌘ is held agree",
      },
      {
        id: "hubtabs-order-per-workspace",
        text: "Another workspace's row is untouched by that drag",
        hint: "Order never inherits: a drag in one strip must not rearrange four others.",
      },
      {
        id: "hubtabs-order-survives-restart",
        text: "The new order survives an app restart",
      },
      {
        id: "hubtabs-hide-app-default",
        text: "Settings → Hub tabs → Sections: crossing out an eye takes that tab out of EVERY workspace's row",
      },
      {
        id: "hubtabs-hide-last-refused",
        text: "Hide all but one: the last eye is disabled, and hovering its ROW says why",
        hint: "The reason hangs on the row because a disabled button never fires mouseenter.",
      },
      {
        id: "hubtabs-hide-workspace-override",
        text: "Workspace Settings → Hub tabs → Sections: a change here affects only that workspace, and the panel now says it keeps a list of its own",
      },
      {
        id: "hubtabs-follow-default-again",
        text: "“Follow the default” puts that workspace back on the app-wide list — including later changes to it",
      },
      {
        id: "hubtabs-hide-active-tab",
        text: "Hiding the tab currently on screen moves you to the first tab left, rather than stranding the view with nothing selected",
      },
      {
        id: "hubtabs-chips-still-reach",
        text: "A sidebar recap chip for a hidden section still opens it",
        hint: "Hiding takes the tab out of the row, not the view out of the app.",
      },
      {
        id: "hubtabs-reset-order",
        text: "Workspace Settings → Hub tabs → “Reset the order” restores the shipped order, and the row shows it immediately",
      },
    ],
  },
  {
    title: "Tools tab",
    items: [
      {
        id: "tools-tab-lists-runnable",
        text: "The Tools tab lists the library's agent / command / script tools and offers no Loop-until, Wait-for-PR or Start-rail row",
        hint: "Those three are completion rules, not work: an until step's verdict sends the RAIL backwards, a pr step is pure waiting on a rail's branch, and a gavin tool's body names a rail action. They are filtered out of the list, not shown disabled.",
      },
      {
        id: "tools-command-settles",
        text: "Running a command tool leaves its row on “passed” (exit 0) or “failed” (anything else), without a reload",
        hint: "Force a failure: duplicate Run tests and give it `exit 3`. The DAEMON closes a shell run off the session exit and pushes nothing, so the row only moves because toolRunsState re-reads on sessionExits — this is the item that catches that watcher being unwired.",
      },
      {
        id: "tools-agent-settles",
        text: "Running an agent tool leaves its row on “passed” when the agent's turn ends — not on “running” forever",
        hint: "An interactive agent's session never exits, so nothing the daemon watches would close the row: the app files the verdict when the session goes idle. Same rule as an agent tool step on a rail.",
      },
      {
        id: "tools-agent-failure",
        text: "An agent tool whose agent breaks lands on “failed”, not “passed”",
        hint: "Kill the network mid-turn. An agent's `idle` is two quiet seconds, so a broken agent and a finished one look identical without failure detection.",
      },
      {
        id: "tools-run-chip-opens-session",
        text: "Clicking a row's last-run chip jumps to that run's session",
        hint: "A chip that says “failed” with no way to see why is a dead end.",
      },
      {
        id: "tools-cwd-runs-there",
        text: "A tool with a working directory set runs THERE — the new tab's cwd is that folder, not the workspace root",
        hint: "Set it with Manage tools… → Choose…; a folder under the root is stored relative, so the row shows `apps/web` rather than an absolute path.",
      },
      {
        id: "tools-cwd-ignored-on-a-rail",
        text: "The SAME tool dropped on a rail still runs in the rail's checkout, ignoring its working directory",
        hint: "Tools spec T6/T11. Rail conflict detection is computed off worktreePath ?? rootPath, so a step that jumped out of its worktree would let two rails collide with nothing left to warn about.",
      },
      {
        id: "tools-params-prompt",
        text: "A tool with parameters asks for them first, prefilled with its defaults, and says which folder it will run in",
        hint: "A tool with none launches straight away — asking about a tool whose whole definition is on the row buys nothing.",
      },
      {
        id: "tools-manage-is-the-same-dialog",
        text: "“Manage tools…” opens the same library dialog the Orchestration tab opens, and a tool saved there appears on both tabs",
        hint: "One library, one editor, one store. Two would drift.",
      },
      {
        id: "tools-old-daemon-explains-itself",
        text: "Against a daemon older than v30 the Run buttons are dark and hovering one names the version",
        hint: "The reason hangs on a wrapper span, not on the button: a disabled element never fires mouseenter, so a tooltip bound to it would never appear. The working-directory field in the dialog is dark for the same reason — a v29 daemon accepts the save and silently drops the field.",
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
