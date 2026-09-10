import { writable } from "svelte/store";
import { parseAttachments } from "$lib/cards/attachments";
import { parseComplexity } from "$lib/cards/complexity";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { refreshBoard } from "$lib/board/kanbanState";
import type { GavinTree, PlanFileInfo } from "$lib/core/gavin";
import type { Workspace } from "$lib/core/workspace";

// One live tree per workspace with a watched root. Fed exclusively by
// gavin-tree-changed pushes -- the initial WatchGavinRoot scan arrives as
// the first push, since there is no request/reply on the streaming
// connection.
export const gavinTrees = writable<Record<string, GavinTree>>({});

// One workspace's `[worktree] setup` lines, keyed by workspace id.
//
// The daemon's tree carries the `[agent]` block but not this one, so it
// has to be read from config.toml on its own. It lives here, beside the
// tree, because it is half of the same question: workspaceTrust hashes
// the agent keys and the setup lines TOGETHER, so a consumer holding one
// without the other cannot answer whether the config is approved -- and
// an unknown half must read as "not approved yet", which is what an
// absent entry gives it.
//
// Re-read on every tree push rather than watched separately: config.toml
// lives inside the watched `.gavin-root`, so an edit to it IS a push.
export const worktreeSetups = writable<Record<string, string[]>>({});

/// Re-reads one workspace's setup lines. Best-effort and silent -- a
/// failed read leaves the entry absent, which fails closed.
///
/// Writes the store only on a real change: this runs on every tree push,
/// and an identical array would invalidate every derived agent in the app
/// (and with it every hub label and terminal title) for nothing.
export async function refreshWorktreeSetup(workspaceId: string, rootPath: string): Promise<void> {
  let lines: string[];
  try {
    lines = await backend.worktreeSetup(rootPath);
  } catch {
    return;
  }
  worktreeSetups.update((m) => {
    const current = m[workspaceId];
    if (current && current.length === lines.length && current.every((l, i) => l === lines[i])) {
      return m;
    }
    return { ...m, [workspaceId]: lines };
  });
}

// Guards watchRootedWorkspaces against double-registration: bootstrap has
// two "workspaces are ready" paths (the workspaces-ready event and
// pollForStartupState), and whichever runs second must be a no-op.
let watchedOnce = false;

// Must be registered BEFORE the first watchGavinRoot call -- Tauri events
// emitted with no listener are lost, not buffered (the Milestone B race
// class). layoutState.bootstrap() registers this in its listener block.
export async function initGavinListeners(): Promise<UnlistenFn> {
  return listen<[string, GavinTree]>("gavin-tree-changed", (event) => {
    const [workspaceId, tree] = event.payload;
    gavinTrees.update((m) => ({ ...m, [workspaceId]: tree }));
    // config.toml sits inside the watched root, so its `[worktree] setup`
    // is re-read here rather than on a watcher of its own -- and it must
    // be re-read on EVERY push, because a change to it is exactly what
    // has to revoke workspace trust.
    if (tree.rootPath) void refreshWorktreeSetup(workspaceId, tree.rootPath);
    // The board's card<->session bindings are no longer written only by
    // this app: an agent that puts a card In Progress through the gavin
    // tools claims it in the daemon (ClaimCardForSession), and nothing
    // pushes that. Riding the tree push is exact rather than lucky --
    // a claim only ever follows a card write, and a card write is what
    // produces this event. Without it the workspace agent's card sits
    // there showing a Run button until something else happens to refetch
    // the board, which is the whole window the double-launch lives in.
    void refreshBoard(workspaceId);
  });
}

export function watchRootedWorkspaces(workspaces: Workspace[]): void {
  if (watchedOnce) return;
  watchedOnce = true;
  for (const ws of workspaces) {
    // Best-effort: a failed watch shows as a missing tree, never blocks
    // startup.
    if (ws.rootPath) void backend.watchGavinRoot(ws.id, ws.rootPath).catch(() => {});
    // Ahead of the first push, so a workspace whose watcher is slow to
    // arm does not spend that window reading as unapproved.
    if (ws.rootPath) void refreshWorktreeSetup(ws.id, ws.rootPath);
  }
}

// On-demand rescan for mutations the watcher can't see: outside contexts
// (extra_contexts) live beyond the watched root, so creating or deleting
// files there never produces a push. Replaces the store entry exactly
// like a push would. Best-effort -- a failure leaves the last tree up.
export async function refreshGavinTree(workspaceId: string): Promise<void> {
  try {
    const tree = await backend.getGavinTree(workspaceId);
    gavinTrees.update((m) => ({ ...m, [workspaceId]: tree }));
    if (tree.rootPath) void refreshWorktreeSetup(workspaceId, tree.rootPath);
  } catch {
    // The watcher or the next mutation will catch up.
  }
}

// Optimistic bridge for the watcher's confirmation latency (spec §2):
// called ONLY after a successful SetPlanFrontmatterField, so a dragged
// card doesn't snap back while waiting for the push. That wait is ~170ms
// for a lone action now (fast-first debounce) and up to the 2s floor only
// under sustained churn -- but a drag is exactly what must never flicker,
// so the bridge stays. The eventual push carries the same tree and
// re-renders as a no-op.
// Optimistic insert for a freshly created card file (two-speed composer,
// card-model spec §4): the watcher push arrives ~170ms later carrying the
// same file and re-renders as a no-op. Skips silently when the context
// isn't in the tree yet or the path already exists.
export function patchPlanCreated(workspaceId: string, contextFolder: string, plan: PlanFileInfo): void {
  gavinTrees.update((m) => {
    const tree = m[workspaceId];
    if (!tree) return m;
    const contexts = tree.contexts.map((ctx) => {
      if (ctx.folderPath !== contextFolder) return ctx;
      if (ctx.plans.some((p) => p.path === plan.path)) return ctx;
      return { ...ctx, plans: [...ctx.plans, plan] };
    });
    return { ...m, [workspaceId]: { ...tree, contexts } };
  });
}

// Optimistic removal for a deleted card file; the watcher push confirms
// ~170ms later.
export function patchPlanRemoved(workspaceId: string, path: string): void {
  gavinTrees.update((m) => {
    const tree = m[workspaceId];
    if (!tree) return m;
    const contexts = tree.contexts.map((ctx) => ({
      ...ctx,
      plans: ctx.plans.filter((p) => p.path !== path),
    }));
    return { ...m, [workspaceId]: { ...tree, contexts } };
  });
}

// A status write can archive the card into `plans/done/` (or bring it
// back), and the daemon answers with the path it landed on. The rescan
// carries the same move ~3s later; until then the projection would hold a
// path that no longer names a file, and every host that keys a card by
// path -- the open modal above all -- would lose it. Re-identify in place:
// only `path` changes, the file keeps its name.
export function patchPlanPath(workspaceId: string, oldPath: string, newPath: string): void {
  if (oldPath === newPath) return;
  gavinTrees.update((m) => {
    const tree = m[workspaceId];
    if (!tree) return m;
    const contexts = tree.contexts.map((ctx) => ({
      ...ctx,
      plans: ctx.plans.map((p) => (p.path === oldPath ? { ...p, path: newPath } : p)),
    }));
    return { ...m, [workspaceId]: { ...tree, contexts } };
  });
}

export function patchPlanField(
  workspaceId: string,
  path: string,
  key:
    | "status"
    | "priority"
    | "order"
    | "title"
    | "parent"
    | "labels"
    | "attachments"
    | "complexity"
    | "agent"
    | "model",
  value: string
): void {
  gavinTrees.update((m) => {
    const tree = m[workspaceId];
    if (!tree) return m;
    const contexts = tree.contexts.map((ctx) => ({
      ...ctx,
      plans: ctx.plans.map((p) => {
        if (p.path !== path) return p;
        if (key === "status") return { ...p, status: value || null };
        if (key === "title") return { ...p, title: value };
        if (key === "priority") return { ...p, priority: value.toLowerCase() as PlanFileInfo["priority"] };
        if (key === "parent") return { ...p, parent: value || null };
        if (key === "labels") {
          return { ...p, labels: value.split(",").map((l) => l.trim()).filter((l) => l.length > 0) };
        }
        // Split the way the daemon's plan_file_info does, so the
        // optimistic patch and the tree that lands a moment later agree
        // about how many chips the card has.
        if (key === "attachments") return { ...p, attachments: parseAttachments(value) };
        // Parsed the way the daemon parses it, so a value it would
        // refuse never lands in the tree as though it had been stored --
        // and an empty value clears the field back to "unrated", which
        // is a different answer from "trivial".
        if (key === "complexity") return { ...p, complexity: parseComplexity(value) };
        // Trimmed the way the daemon trims them, and an empty value
        // clears the line back to inheriting -- which is a different
        // answer from naming the profile the workspace happens to be on.
        if (key === "agent") return { ...p, agent: value.trim() || null };
        if (key === "model") return { ...p, model: value.trim() || null };
        const n = Number(value);
        return Number.isFinite(n) ? { ...p, order: n } : p;
      }),
    }));
    return { ...m, [workspaceId]: { ...tree, contexts } };
  });
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  watchedOnce = false;
  gavinTrees.set({});
  worktreeSetups.set({});
}
