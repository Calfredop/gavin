// Puts the desktop's module-level stores back the way a fresh page finds
// them. They are module-level on purpose (they belong to the app, not to
// a component), which in a suite means one test's Workstation is still
// in them when the next one connects.
import { DEFAULT_LAUNCH } from "$lib/agents/launchGate";
import { launchConfigStore } from "$lib/agents/launchQueue";
import { __resetForTesting as resetTurnVerdict } from "$lib/agents/turnVerdictDriver";
import { kanbanState } from "$lib/board/kanbanState";
import { EMPTY_AGENT_DEFAULTS } from "$lib/cards/complexity";
import { __resetForTesting as resetGavinState } from "$lib/core/gavinState";
import { resetDialogs } from "$lib/core/dialog";
import {
  agentDefaultsStore,
  agentModelDefaultsStore,
  agentProfilesStore,
  autoCommitDefault,
  gitTrackingDefault,
  layoutState,
  requireReviewDefault,
  terminalFontSizeDefault,
} from "$lib/core/layoutState";
import { __resetForTesting as resetOrchestration } from "$lib/orchestration/orchestrationState";

export function resetDesktopStores(): void {
  resetTurnVerdict();
  resetOrchestration();
  resetGavinState();
  resetDialogs();
  kanbanState.set({});
  // The app-wide settings, as a page finds them before its first read.
  agentProfilesStore.set([]);
  agentModelDefaultsStore.set({});
  agentDefaultsStore.set(EMPTY_AGENT_DEFAULTS);
  terminalFontSizeDefault.set(null);
  autoCommitDefault.set(null);
  requireReviewDefault.set(null);
  gitTrackingDefault.set(null);
  launchConfigStore.set(DEFAULT_LAUNCH);
  layoutState.set({
    status: "connecting",
    errorMessage: "",
    workspaces: [],
    activeWorkspaceId: null,
    focusedSessionId: null,
    cwdBySessionId: {},
    sessionNames: {},
    sessionStatusById: {},
    gitStatusById: {},
    restoredSessionIds: new Set(),
    interruptedSessionIds: new Set(),
    orphanBySessionId: {},
    failureReasonById: {},
    statusSinceById: {},
    sessionsSeenWorking: new Set(),
    readSessionIds: new Set(),
    fileTabsById: {},
    boardTabsById: {},
    cardTabsById: {},
    removedWorkspaces: [],
  });
}

/// A Device's storage, as a map a suite can read.
export function deviceStorage(seed: Record<string, string> = {}) {
  const items: Record<string, string> = { ...seed };
  return {
    items,
    getItem: (key: string): string | null => items[key] ?? null,
    setItem: (key: string, value: string): void => void (items[key] = value),
  };
}
