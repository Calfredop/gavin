// What happens on the Demo Workstation while somebody is looking at it.
//
// A short loop of the things agents do: one gets its answer and carries
// on, a checklist moves, another stops to ask, a card is finished. Each
// step changes the demo's state and pushes the event a desk would push
// for that change, so what the bundle hears and what it would read back
// are always the same fact.
//
// No clock in here. The page that hosts a demo advances it on a timer of
// its own; a suite advances it by hand.
import type { PlanFileInfo } from "$lib/core/gavin";
import type { DemoContext } from "$companion/demo/commands";
import { DEMO, sampleState } from "$companion/demo/sampleData";

export type DemoStep = (demo: DemoContext) => void;

function setStatus(demo: DemoContext, sessionId: string, status: string): void {
  const session = demo.state.sessions.find((s) => s.id === sessionId);
  if (!session || session.status === status) return;
  session.status = status;
  demo.emit("session-status-changed", [sessionId, status]);
}

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

export const ACTIVITY: DemoStep[] = [
  // The human answered the session-store question at the desk.
  (demo) => setStatus(demo, "s-atlas-store", "working"),

  (demo) =>
    changeCard(demo, DEMO.atlas, "token-refresh.md", (plan) => {
      plan.checklistDone += 1;
    }),

  // field-notes' agent stops to ask.
  (demo) => setStatus(demo, "s-notes-sync", "waiting_for_input"),

  // A reviewed card is finished. Done is a folder as well as a status:
  // the daemon files a finished card under `plans/done/`.
  (demo) =>
    changeCard(demo, DEMO.atlas, "openapi-accounts.md", (plan) => {
      plan.status = "Done";
      plan.path = plan.path.replace("/plans/", "/plans/done/");
    }),

  (demo) => {
    setStatus(demo, "s-notes-sync", "working");
    changeCard(demo, DEMO.atlas, "token-refresh.md", (plan) => {
      plan.checklistDone += 1;
    });
  },

  // And round again: what this loop moved, put back as it was found and
  // said as a desk would say it -- every session's status, every sample
  // card. Only that. What a visitor changed -- a setting, a saved file, a
  // commit, an agent's model, a workspace added or renamed -- stays, as it
  // would on a real Workstation; a loop that put the whole machine back
  // would undo it under them a lap later.
  (demo) => {
    const fresh = sampleState();
    for (const session of fresh.sessions) setStatus(demo, session.id, session.status);
    for (const [workspaceId, tree] of Object.entries(fresh.trees)) {
      const live = demo.state.trees[workspaceId];
      if (!live) continue;
      for (const context of live.contexts) {
        const found = tree.contexts.find((c) => c.folderPath === context.folderPath);
        if (found) context.plans = found.plans;
      }
      demo.emit("gavin-tree-changed", [workspaceId, live]);
    }
  },
];
