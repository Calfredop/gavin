// What happens on the Demo Workstation while somebody is looking at it.
//
// A short loop of the things agents do: one gets its answer and carries
// on, a checklist moves, another stops to ask, a card is finished. Each
// step changes the demo's state and pushes the event a desk would push
// for that change, so what the bundle hears and what it would read back
// are always the same fact -- a terminal's screen included.
//
// No clock in here. The page that hosts a demo advances it on a timer of
// its own; a suite advances it by hand.
import { parseChecklist } from "$lib/cards/planChecklist";
import { CARD_COMMANDS, cardNamed, putBack } from "$companion/demo/cardCommands";
import type { DemoContext } from "$companion/demo/commands";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import { restore, setStatus, type as typeInto, write } from "$companion/demo/sessions";
import { NOTES_PERMISSION, notesPermission, STORE_ANSWERED_AT_DESK } from "$companion/demo/transcripts";

export type DemoStep = (demo: DemoContext) => void;

/// An agent ticks the next item of a card's checklist, through the same
/// command a desk's agent writes it with.
function tickNext(demo: DemoContext, fileName: string): void {
  const path = cardNamed(demo, fileName);
  const next = path ? parseChecklist(demo.state.files[path]).find((item) => !item.checked) : undefined;
  if (!path || !next) return;
  CARD_COMMANDS.set_checklist_item({ path, lineIndex: next.lineIndex, expectedText: next.rawText, checked: true }, demo);
}

/// ...and moves a card to a column.
function moveCard(demo: DemoContext, fileName: string, status: string): void {
  const path = cardNamed(demo, fileName);
  if (path) CARD_COMMANDS.set_plan_frontmatter_field({ path, key: "status", value: status }, demo);
}

/// Answers a session's menu as the human at the desk would: by typing
/// the option's digit into it. A menu already answered from the phone
/// has nothing left to answer.
function answerAtDesk(demo: DemoContext, sessionId: string, option: number): void {
  const program = demo.state.terminals[sessionId]?.program;
  if (program?.kind !== "agent" || program.ask.kind !== "menu") return;
  typeInto(demo, sessionId, String(option));
}

/// The sessions whose screens this loop moves on, and so puts back.
const SCRIPTED = ["s-atlas-store", "s-notes-sync"];
/// ...and the cards.
const SCRIPTED_CARDS = ["token-refresh.md", "openapi-accounts.md"];

// Ordered so that an agent is waiting on a menu for most of the loop:
// the quick replies are what a phone is picked up to try, and a reviewer
// who opens the demo a few seconds late should still find one to answer.
export const ACTIVITY: DemoStep[] = [
  // field-notes' agent stops to ask.
  (demo) => {
    const terminal = demo.state.terminals["s-notes-sync"];
    if (terminal?.program.kind !== "agent" || terminal.program.ask.kind !== "working") return;
    terminal.program.ask = NOTES_PERMISSION;
    write(demo, "s-notes-sync", notesPermission(DEMO.notesRoot));
    setStatus(demo, "s-notes-sync", "waiting_for_input");
  },

  (demo) => tickNext(demo, "token-refresh.md"),

  // A reviewed card is finished. Done is a folder as well as a status:
  // the daemon files a finished card under `plans/done/`.
  (demo) => moveCard(demo, "openapi-accounts.md", "Done"),

  // The human answered the session-store question at the desk.
  (demo) => answerAtDesk(demo, "s-atlas-store", STORE_ANSWERED_AT_DESK),

  (demo) => {
    answerAtDesk(demo, "s-notes-sync", 1);
    tickNext(demo, "token-refresh.md");
  },

  // And round again: what this loop moved, put back as it was found and
  // said as a desk would say it. The two scripted agents are put back to
  // asking, to be answered again from the phone or at the desk, and the
  // two scripted cards where they started. Only that. What a visitor
  // changed -- a session opened or ended, a card moved, filed or
  // answered, a setting, a saved file, a commit, a workspace added or
  // renamed -- stays, as it would on a real Workstation; a loop that put
  // the whole machine back would undo it under them a lap later.
  (demo) => {
    const fresh = sampleState();
    for (const id of SCRIPTED) {
      if (!demo.state.terminals[id]) continue;
      restore(demo, id, fresh.terminals[id]);
      setStatus(demo, id, fresh.sessions.find((s) => s.id === id)!.status);
    }
    putBack(demo, fresh.files, SCRIPTED_CARDS);
  },
];
