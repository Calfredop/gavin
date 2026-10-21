// What the activity calendar reads, and from where. Two reads per
// workspace -- its runs from the daemon that keeps them, its git history
// from its folder -- each asked once per load, side by side across the
// fleet. A workspace that cannot answer is counted and named rather than
// failing the calendar: the rest of the fleet's year is still worth
// drawing.
//
// `planLoads` is pure (which read each workspace gets, or why not);
// `loadActivity` runs a plan through the two backend calls it is handed.

import type { Workspace } from "$lib/core/workspace";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import { isSshWorkspace, sshActivityBlocked, sshTabBlocked, type SshLinks } from "$lib/workspace/sshWorkspace";
import type { ActivityRun, GitActivity, WorkspaceActivity } from "$lib/activity/activity";

/// A read that is not made, and the sentence saying why.
export interface Blocked {
  blocked: string;
}

export interface LoadPlan {
  workspaceId: string;
  workspaceName: string;
  /// Set when nothing can be read at all -- an ssh host whose link is
  /// down. The workspace is counted as unavailable and skipped.
  unreachable: string | null;
  runs: "read" | Blocked;
  /// `none` for a workspace with no folder: it has runs and no history.
  git: "read" | "none" | Blocked;
  cwd: string | null;
}

/// Which reads each workspace gets. A local workspace's runs are the
/// local daemon's, gated on its version; an ssh workspace's are its
/// HOST's, gated on the host's (`sshActivityBlocked`), and its history
/// goes over the same link (`sshTabBlocked`). A daemon too old for the
/// run read still leaves the git half to draw.
export function planLoads(workspaces: readonly Workspace[], compat: DaemonCompat | null, links: SshLinks): LoadPlan[] {
  return workspaces.map((ws) => {
    const cwd = ws.rootPath?.trim() || null;
    const base = { workspaceId: ws.id, workspaceName: ws.name, cwd };
    if (isSshWorkspace(ws)) {
      const link = links[ws.ssh.host];
      if (!link || link.status !== "ready") {
        return { ...base, unreachable: sshActivityBlocked(ws, links) ?? `Not connected to ${ws.ssh.host}.`, runs: "read", git: "none" };
      }
      const runsWhy = sshActivityBlocked(ws, links);
      const gitWhy = sshTabBlocked(ws, links);
      return {
        ...base,
        unreachable: null,
        runs: runsWhy ? { blocked: runsWhy } : "read",
        git: !cwd ? "none" : gitWhy ? { blocked: gitWhy } : "read",
      };
    }
    const runsWhy = featureBlockedReason(compat, "activityCalendar");
    return { ...base, unreachable: null, runs: runsWhy ? { blocked: runsWhy } : "read", git: cwd ? "read" : "none" };
  });
}

export interface LoadDeps {
  activityRuns(workspaceId: string, since: number, until: number): Promise<ActivityRun[]>;
  gitActivity(cwd: string, since: number): Promise<GitActivity>;
}

export interface Unavailable {
  workspaceId: string;
  name: string;
  reason: string;
}

export interface ActivityLoad {
  sources: WorkspaceActivity[];
  /// Workspaces a read failed for, or that could not be reached at all.
  /// What the other read of one returned is still in `sources`.
  unavailable: Unavailable[];
  /// Reads not made because a daemon is too old, one entry per reason:
  /// every local workspace shares the local daemon's, so the calendar
  /// says it once rather than once a workspace.
  missing: { what: "runs" | "history"; reason: string; names: string[] }[];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function loadActivity(
  plans: readonly LoadPlan[],
  window: { since: number; until: number },
  deps: LoadDeps
): Promise<ActivityLoad> {
  const unavailable: Unavailable[] = [];
  const missing = new Map<string, ActivityLoad["missing"][number]>();
  const miss = (what: "runs" | "history", reason: string, name: string) => {
    const key = `${what}\u0000${reason}`;
    const entry = missing.get(key) ?? { what, reason, names: [] };
    entry.names.push(name);
    missing.set(key, entry);
  };
  const reads = plans.map(async (plan): Promise<WorkspaceActivity | null> => {
    if (plan.unreachable) {
      unavailable.push({ workspaceId: plan.workspaceId, name: plan.workspaceName, reason: plan.unreachable });
      return null;
    }
    if (plan.runs !== "read") miss("runs", plan.runs.blocked, plan.workspaceName);
    if (typeof plan.git === "object") miss("history", plan.git.blocked, plan.workspaceName);
    const cwd = plan.cwd;
    const [runs, git] = await Promise.allSettled([
      plan.runs === "read" ? deps.activityRuns(plan.workspaceId, window.since, window.until) : Promise.resolve(null),
      plan.git === "read" && cwd ? deps.gitActivity(cwd, window.since) : Promise.resolve(null),
    ]);
    const failed = [runs, git].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length > 0) {
      unavailable.push({ workspaceId: plan.workspaceId, name: plan.workspaceName, reason: message(failed[0].reason) });
    }
    return {
      workspaceId: plan.workspaceId,
      workspaceName: plan.workspaceName,
      runs: runs.status === "fulfilled" ? runs.value : null,
      git: git.status === "fulfilled" ? git.value : null,
    };
  });
  const sources = (await Promise.all(reads)).filter((s): s is WorkspaceActivity => s !== null);
  const order = new Map(plans.map((p, i) => [p.workspaceId, i]));
  unavailable.sort((a, b) => (order.get(a.workspaceId) ?? 0) - (order.get(b.workspaceId) ?? 0));
  return { sources, unavailable, missing: [...missing.values()] };
}

/// The line under the calendar for what could not be read: "2 workspaces
/// unavailable" at app level, the reason itself for one workspace.
export function unavailableLine(load: ActivityLoad, scope: "app" | "workspace"): string | null {
  const n = load.unavailable.length;
  if (n === 0) return null;
  if (scope === "workspace") return `Activity unavailable — ${load.unavailable[0].reason}`;
  return `${n} ${n === 1 ? "workspace" : "workspaces"} unavailable`;
}

/// The tooltip that names them.
export function unavailableTip(load: ActivityLoad): string {
  return load.unavailable.map((u) => `${u.name}: ${u.reason}`).join("\n");
}

/// One sentence per read a daemon was too old for.
export function missingLines(load: ActivityLoad, scope: "app" | "workspace"): string[] {
  return load.missing.map((m) => {
    const what = m.what === "runs" ? "Runs are not shown" : "Commits and pushes are not shown";
    const where = scope === "app" ? ` for ${m.names.join(", ")}` : "";
    return `${what}${where}. ${m.reason}`;
  });
}
