import { writable, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LayoutNode } from "./layout";
import * as layout from "./layout";
import * as backend from "./backend";
import * as terminalRegistry from "./terminalRegistry";

export interface LayoutState {
  status: "connecting" | "ready" | "error";
  errorMessage: string;
  tree: LayoutNode | null;
  focusedSessionId: string | null;
  cwdBySessionId: Record<string, string>;
}

const initialState: LayoutState = {
  status: "connecting",
  errorMessage: "",
  tree: null,
  focusedSessionId: null,
  cwdBySessionId: {},
};

export const layoutState = writable<LayoutState>(initialState);

function setError(message: string): void {
  layoutState.update((s) => ({ ...s, status: "error", errorMessage: message }));
}

// Shared by every action below that ends in "mutate the tree, then
// persist it" -- extracted so that pattern exists exactly once instead of
// once per action.
async function persistLayout(tree: LayoutNode): Promise<void> {
  try {
    await backend.setLayout(tree);
  } catch (e) {
    setError(String(e));
  }
}

// Shared by every action that creates exactly one fresh session before
// mutating the tree (splitPane, addTab, newSessionFromEmpty). Returns null
// -- having already called setError -- on failure, so callers just check
// for null rather than duplicating their own try/catch.
async function createFreshSession(): Promise<string | null> {
  try {
    return await backend.createSession();
  } catch (e) {
    setError(String(e));
    return null;
  }
}

const unlisteners: UnlistenFn[] = [];

export async function bootstrap(): Promise<void> {
  unlisteners.push(
    await listen<LayoutNode>("layout-ready", (event) => {
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        return {
          ...s,
          status: "ready",
          tree: event.payload,
          focusedSessionId: layout.allSessionIds(event.payload)[0] ?? null,
        };
      });
    })
  );
  unlisteners.push(
    await listen<[string, number]>("session-exited", (event) => {
      handleSessionExited(event.payload[0]);
    })
  );
  unlisteners.push(
    await listen<string>("daemon-error", (event) => {
      setError(event.payload);
    })
  );
  unlisteners.push(
    await listen<[string, string]>("cwd-changed", (event) => {
      handleCwdChanged(event.payload[0], event.payload[1]);
    })
  );

  void pollForStartupState();
}

export function teardown(): void {
  unlisteners.forEach((unlisten) => unlisten());
  unlisteners.length = 0;
}

async function pollForStartupState(): Promise<void> {
  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (get(layoutState).status !== "connecting") return;
    const [tree, bootstrapError] = await Promise.all([
      backend.getCurrentLayout().catch(() => null),
      backend.getBootstrapError().catch(() => null),
    ]);
    if (bootstrapError) {
      setError(bootstrapError);
      return;
    }
    if (tree) {
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        return { ...s, status: "ready", tree, focusedSessionId: layout.allSessionIds(tree)[0] ?? null };
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (get(layoutState).status === "connecting") {
    setError("Timed out waiting for the daemon to become reachable.");
  }
}

export async function splitPane(targetSessionId: string, direction: "row" | "column"): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  const newId = await createFreshSession();
  if (!newId) return;
  const tree = layout.splitLeaf(state.tree, targetSessionId, direction, newId);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: newId }));
  await persistLayout(tree);
}

export async function addTab(targetSessionId: string): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  const newId = await createFreshSession();
  if (!newId) return;
  const tree = layout.addTab(state.tree, targetSessionId, newId);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: newId }));
  await persistLayout(tree);
}

export async function closeSession(sessionId: string): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  try {
    await backend.killSession(sessionId);
  } catch (e) {
    setError(String(e));
    return;
  }
  handleSessionExited(sessionId);
}

// Shared by closeSession (after a successful daemon-side kill) and the
// session-exited event listener (the session is already dead, so no
// killSession call happens here) -- both cases mean "remove this session
// from the tree." See Global Constraints for why the empty-tree case
// deliberately skips persistence.
//
// Guarded against sessions already absent from the tree: closeSession
// removes the session from the tree immediately after a successful kill,
// but the daemon separately emits its own session-exited event once the
// session actually dies, re-entering this function for an id that's
// already gone. Without the findLeafPath guard below, layout.closeTab
// would throw (it assumes the session is present), and that throw would
// escape uncaught from inside a Tauri event callback. applyPreset's old-
// session cleanup can trigger this same double-removal path too.
export function handleSessionExited(sessionId: string): void {
  const state = get(layoutState);
  if (!state.tree) return;
  if (!layout.findLeafPath(state.tree, sessionId)) return;
  const tree = layout.closeTab(state.tree, sessionId);
  const focusedSessionId =
    state.focusedSessionId === sessionId
      ? (tree ? (layout.allSessionIds(tree)[0] ?? null) : null)
      : state.focusedSessionId;
  layoutState.update((s) => ({ ...s, tree, focusedSessionId }));
  terminalRegistry.destroyTerminal(sessionId);
  if (tree) {
    void persistLayout(tree);
  }
}

// Shared by the "cwd-changed" event listener in bootstrap() and this
// file's own tests -- mirrors handleSessionExited's pattern of being both
// an event callback and independently testable. Entries are never removed
// when a session closes; a stale in-memory map entry per session that ever
// existed in one app run is not a meaningful memory concern.
export function handleCwdChanged(sessionId: string, cwd: string): void {
  layoutState.update((s) => ({ ...s, cwdBySessionId: { ...s.cwdBySessionId, [sessionId]: cwd } }));
}

export async function switchToTab(sessionId: string): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  const tree = layout.switchTab(state.tree, sessionId);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: sessionId }));
  await persistLayout(tree);
}

export function focusPane(sessionId: string): void {
  layoutState.update((s) => ({ ...s, focusedSessionId: sessionId }));
}

// Updates the tree's sizes without persisting -- used for live visual
// feedback while a divider drag is in progress. Call commitLayout() once,
// on drag-end, to actually persist; calling backend.setLayout on every
// pointermove would flood the daemon with writes and risks out-of-order
// completions leaving a stale mid-drag size persisted instead of the final
// one.
export function previewResizePane(splitPath: number[], sizes: number[]): void {
  const state = get(layoutState);
  if (!state.tree) return;
  const tree = layout.resizeSplit(state.tree, splitPath, sizes);
  layoutState.update((s) => ({ ...s, tree }));
}

// Persists whatever the current tree is. Call once after a batch of
// previewResizePane calls (e.g. on pointerup), not per intermediate step.
export async function commitLayout(): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  await persistLayout(state.tree);
}

export async function applyPreset(
  buildTree: (freshIds: string[]) => LayoutNode,
  sessionCount: number
): Promise<void> {
  const state = get(layoutState);
  const oldIds = state.tree ? layout.allSessionIds(state.tree) : [];
  let freshIds: string[];
  try {
    freshIds = await Promise.all(Array.from({ length: sessionCount }, () => backend.createSession()));
  } catch (e) {
    setError(String(e));
    return;
  }
  const tree = buildTree(freshIds);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: freshIds[0] ?? null }));
  // Old sessions are killed best-effort *after* the new tree is already
  // committed -- unlike closeSession, applying a preset is spec'd as an
  // already-deliberate action, so one stuck kill shouldn't block it.
  await Promise.all(
    oldIds.map((id) =>
      backend
        .killSession(id)
        .catch(() => {})
        .finally(() => terminalRegistry.destroyTerminal(id))
    )
  );
  await persistLayout(tree);
}

// Closes every tab in the pane containing anySessionId -- distinct from
// closeSession (which closes just the one named session). Used by the
// toolbar's "Close Pane" button; Cmd+W intentionally stays scoped to a
// single tab via closeSession, per the design spec.
export async function closePane(anySessionId: string): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  const path = layout.findLeafPath(state.tree, anySessionId);
  if (!path) return;
  const leaf = layout.getNodeAtPath(state.tree, path);
  if (leaf.type !== "leaf") return;
  const sessionIds = [...leaf.tabs];

  for (const id of sessionIds) {
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return;
    }
  }

  let tree: LayoutNode | null = state.tree;
  for (const id of sessionIds) {
    if (!tree) break;
    tree = layout.closeTab(tree, id);
    terminalRegistry.destroyTerminal(id);
  }

  const focusedSessionId = sessionIds.includes(state.focusedSessionId ?? "")
    ? (tree ? (layout.allSessionIds(tree)[0] ?? null) : null)
    : state.focusedSessionId;

  layoutState.update((s) => ({ ...s, tree, focusedSessionId }));
  if (tree) {
    void persistLayout(tree);
  }
}

export async function newSessionFromEmpty(): Promise<void> {
  const newId = await createFreshSession();
  if (!newId) return;
  const tree = layout.presetSingle(newId);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: newId }));
  await persistLayout(tree);
}
