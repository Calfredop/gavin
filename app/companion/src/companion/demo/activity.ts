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
import type { PlanFileInfo } from "$lib/core/gavin";
import type { DemoContext } from "$companion/demo/commands";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import { restore, setStatus, type as typeInto, write } from "$companion/demo/sessions";
import { NOTES_PERMISSION, notesPermission, STORE_ANSWERED_AT_DESK } from "$companion/demo/transcripts";

export type DemoStep = (demo: DemoContext) => void;

function changeCard(
  demo: DemoContext,
  workspaceId: string,
  fileName: string,
  change: (plan: PlanFileInfo) => void
): void {
  const tree = demo.state.trees[workspaceId];
  const plan = tree?.contexts.flatMap((ctx) => ctx.plans).find((p) => p.fileName === fileName);
  if (!tree || !plan) return;
  change(plan);
  demo.emit("gavin-tree-changed", [workspaceId, tree]);
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

  (demo) =>
    changeCard(demo, DEMO.atlas, "token-refresh.md", (plan) => {
      plan.checklistDone += 1;
    }),

  // A reviewed card is finished. Done is a folder as well as a status:
  // the daemon files a finished card under `plans/done/`.
  (demo) =>
    changeCard(demo, DEMO.atlas, "openapi-accounts.md", (plan) => {
      plan.status = "Done";
      plan.path = plan.path.replace("/plans/", "/plans/done/");
    }),

  // The human answered the session-store question at the desk.
  (demo) => answerAtDesk(demo, "s-atlas-store", STORE_ANSWERED_AT_DESK),

  (demo) => {
    answerAtDesk(demo, "s-notes-sync", 1);
    changeCard(demo, DEMO.atlas, "token-refresh.md", (plan) => {
      plan.checklistDone += 1;
    });
  },

  // And round again: the machine as it was found, said as a desk would
  // say it. The two scripted agents are put back to asking, to be
  // answered again from the phone or at the desk; a session the human
  // opened or ended on the demo stays as they left it.
  (demo) => {
    const fresh = sampleState();
    for (const id of SCRIPTED) {
      if (!demo.state.terminals[id]) continue;
      restore(demo, id, fresh.terminals[id]);
      setStatus(demo, id, fresh.sessions.find((s) => s.id === id)!.status);
    }
    demo.state.trees = fresh.trees;
    for (const [workspaceId, tree] of Object.entries(demo.state.trees)) {
      demo.emit("gavin-tree-changed", [workspaceId, tree]);
    }
  },
];
