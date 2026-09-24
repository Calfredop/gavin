// ssh workspaces, as the frontend sees them: which workspaces are on
// another machine, the state of each host's link, what a badge and a
// banner say about it, and what the creation form accepts.
//
// The link itself lives in the Tauri host (`app/src-tauri/src/remote.rs`)
// and speaks through two events, `remote-link-ready` and
// `remote-link-lost`; `sshLinkState.ts` turns those into the store this
// module's reducers write. Nothing here talks to a daemon. See
// `docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md` §4.

import type { SshConfig, Workspace } from "$lib/core/workspace";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";

/// A workspace that lives on another machine, reached over ssh.
export function isSshWorkspace(ws: Workspace | null | undefined): ws is Workspace & { ssh: SshConfig } {
  return Boolean(ws?.ssh?.host);
}

/// The one sentence every surface that cannot serve an ssh workspace yet
/// shows in place of its content. One string, so the Git tab, the Files
/// tab and a card's Run pill cannot drift into three explanations of the
/// same gap. The surfaces it names are the ones that run against THIS
/// machine's disk: the card-runs and git/files follow-up cards remove
/// them one by one.
export const SSH_LIMITATION =
  "Not available for ssh workspaces yet — the Git tab, Files tab, worktrees and the setup wizard work on this machine's disk, and this workspace lives on another.";

/// The limitation for a workspace, or null when there is none: a local
/// workspace has every surface.
export function sshLimitation(ws: Workspace | null | undefined): string | null {
  return isSshWorkspace(ws) ? SSH_LIMITATION : null;
}

export type SshLinkStatus = "connecting" | "ready" | "lost";

export interface SshLink {
  status: SshLinkStatus;
  /// What the host runs, from the bridge's banner, once a link has been
  /// up. Kept across a reconnect so a badge does not blink blank.
  hostOs?: string;
  /// The HOST daemon's protocol version, once a link has been up. What
  /// anything needing a newer daemon on the host gates on -- the local
  /// verdict says nothing about the machine the run happens on.
  daemonVersion?: number;
  /// Why the link is lost, in ssh's or the app's words. Only ever set
  /// with `lost`.
  message?: string;
}

/// Host -> its link. Keyed by host rather than by workspace because the
/// Tauri host holds one link per host and every workspace on it shares
/// its fate.
export type SshLinks = Readonly<Record<string, SshLink>>;

/// Every ssh workspace's host that the map does not know yet becomes
/// `connecting`: bootstrap links each host after `workspaces-ready`, so
/// between the two events the honest state is "on its way". A host
/// already known keeps what it has.
export function seedConnecting(links: SshLinks, workspaces: Workspace[]): SshLinks {
  let next: Record<string, SshLink> | null = null;
  for (const ws of workspaces) {
    if (!isSshWorkspace(ws) || ws.ssh.host in links || (next && ws.ssh.host in next)) continue;
    next ??= { ...links };
    next[ws.ssh.host] = { status: "connecting" };
  }
  return next ?? links;
}

/// What a link keeps across its states: the facts the last ready event
/// established about the host.
function carried(previous: SshLink | undefined): Pick<SshLink, "hostOs" | "daemonVersion"> {
  const kept: Pick<SshLink, "hostOs" | "daemonVersion"> = {};
  if (previous?.hostOs) kept.hostOs = previous.hostOs;
  if (previous?.daemonVersion !== undefined) kept.daemonVersion = previous.daemonVersion;
  return kept;
}

export function markConnecting(links: SshLinks, host: string): SshLinks {
  return { ...links, [host]: { status: "connecting", ...carried(links[host]) } };
}

export function markReady(
  links: SshLinks,
  host: string,
  hostOs: string | null | undefined,
  daemonVersion?: number | null
): SshLinks {
  const link: SshLink = { status: "ready", ...carried(links[host]) };
  if (hostOs) link.hostOs = hostOs;
  if (daemonVersion !== null && daemonVersion !== undefined) link.daemonVersion = daemonVersion;
  return { ...links, [host]: link };
}

export function markLost(links: SshLinks, host: string, message: string | null | undefined): SshLinks {
  const link: SshLink = { status: "lost", ...carried(links[host]) };
  if (message) link.message = message;
  return { ...links, [host]: link };
}

/// Whether an ssh workspace can do a thing that needs its host daemon at
/// version `needed` right now, and if not, why -- null for a local
/// workspace, whose gates are elsewhere.
///
/// The order is the order a human fixes it in: the link is not up
/// (`reconnectVerb` says what to do), then the host's daemon is too old
/// (checked against the HOST's version, never the local daemon's), then
/// nothing. Shared by the card-run gate and the tab gate so they answer
/// on the same evidence.
function sshFeatureBlocked(
  ws: Workspace | null | undefined,
  links: SshLinks,
  needed: number,
  reconnectVerb: string
): string | null {
  if (!isSshWorkspace(ws)) return null;
  const host = ws.ssh.host;
  const link = linkFor(links, ws);
  if (!link || link.status === "connecting") return `Connecting to ${host} over ssh — try again in a moment.`;
  if (link.status === "lost") return `Not connected to ${host} — reconnect the workspace ${reconnectVerb}.`;
  if (link.daemonVersion === undefined || link.daemonVersion < needed) {
    const running = link.daemonVersion === undefined ? "an older version" : `v${link.daemonVersion}`;
    return `Needs gavin-daemon v${needed} on ${host}; the daemon there is ${running}. Update it on the host and reconnect.`;
  }
  return null;
}

/// Whether a card can be run on this workspace right now (see
/// `sshFeatureBlocked`). The launch seam asks the same question as the Run
/// pill, so a queued intent and a rail step refuse on the same evidence.
export function sshRunBlocked(ws: Workspace | null | undefined, links: SshLinks): string | null {
  return sshFeatureBlocked(ws, links, FEATURE_MIN_VERSION.sshCardRuns, "to run cards there");
}

/// Whether the Git tab and Files tree can serve this workspace right now.
/// Their operations need the host daemon's v40 file and git requests, so
/// this is what the two hub views gate on -- rendering their content when
/// it is null and the notice otherwise.
export function sshTabBlocked(ws: Workspace | null | undefined, links: SshLinks): string | null {
  return sshFeatureBlocked(ws, links, FEATURE_MIN_VERSION.sshGitFiles, "to use these tabs there");
}

/// Whether the parts of those tabs that need the host daemon to run a
/// git op of its own, watch its own worktree or change its own tree can
/// serve this workspace right now: fetch/pull/push, and the Files tree's
/// new/rename/trash. A host at v41 runs the rest of the tab and answers
/// null from `sshTabBlocked` while this one says what is still missing,
/// which is exactly the split the two entries describe.
export function sshSyncBlocked(ws: Workspace | null | undefined, links: SshLinks): string | null {
  return sshFeatureBlocked(ws, links, FEATURE_MIN_VERSION.sshGitSync, "to use them there");
}

/// The hosts whose link is up -- what `staleLayoutTabIds` needs to know
/// which ssh workspaces' tabs the baselines can vouch for.
export function readyHosts(links: SshLinks): Set<string> {
  return new Set(Object.entries(links).filter(([, l]) => l.status === "ready").map(([host]) => host));
}

/// A workspace's link: null for a local workspace, `connecting` for an
/// ssh workspace whose host nothing has reported on yet.
export function linkFor(links: SshLinks, ws: Workspace | null | undefined): SshLink | null {
  if (!isSshWorkspace(ws)) return null;
  return links[ws.ssh.host] ?? { status: "connecting" };
}

export interface SshBadge {
  host: string;
  status: SshLinkStatus;
  tip: string;
}

/// What a sidebar row shows beside an ssh workspace's name. A mark, not
/// one of `ui/indicators.ts`'s axes: it answers "where is it", which is
/// not a state of an agent, a rail or a git checkout.
export function sshBadge(ws: Workspace | null | undefined, links: SshLinks): SshBadge | null {
  const link = linkFor(links, ws);
  if (!link || !isSshWorkspace(ws)) return null;
  const host = ws.ssh.host;
  switch (link.status) {
    case "ready":
      return { host, status: "ready", tip: `On ${host} over ssh${link.hostOs ? ` (${link.hostOs})` : ""}` };
    case "connecting":
      return { host, status: "connecting", tip: `On ${host} over ssh — connecting…` };
    case "lost":
      return {
        host,
        status: "lost",
        tip: `On ${host} over ssh — connection lost${link.message ? `: ${link.message}` : ""}`,
      };
  }
}

export interface SshBanner {
  tone: "muted" | "warning";
  text: string;
}

/// The strip above the workspace's tabs, which speaks only while the
/// link is not up: connecting is a wait, lost is a problem with a
/// Reconnect beside it. A link that is up is not news, the same rule
/// the root control applies to a healthy root.
export function sshBanner(ws: Workspace | null | undefined, links: SshLinks): SshBanner | null {
  const link = linkFor(links, ws);
  if (!link || !isSshWorkspace(ws)) return null;
  const host = ws.ssh.host;
  switch (link.status) {
    case "ready":
      return null;
    case "connecting":
      return { tone: "muted", text: `Connecting to ${host} over ssh…` };
    case "lost":
      return {
        tone: "warning",
        text: `Lost the connection to ${host}${link.message ? ` — ${link.message}` : ""}`,
      };
  }
}

/// The creation and settings form, as typed.
export interface SshWorkspaceInput {
  host: string;
  rootPath: string;
  daemonPath: string;
}

export type SshInputVerdict =
  | { ok: true; ssh: SshConfig; rootPath: string }
  | { ok: false; error: string };

/// What the form accepts, and why not.
///
/// The root is an absolute path ON THE HOST, and it crosses the wire
/// with forward slashes like every path gavin carries -- so a Windows
/// path typed with backslashes is normalised here rather than refused,
/// while `~` and a relative path are refused because neither means
/// anything to a daemon that resolves nothing. The host and daemon-path
/// rules mirror the Tauri host's own (`remote.rs::ssh_command`), so a
/// value this form accepts is one the link will run.
export function validateSshInput(input: SshWorkspaceInput): SshInputVerdict {
  const host = input.host.trim();
  if (!host) return { ok: false, error: "Name the ssh host (anything `ssh <host>` accepts)." };
  if (host.startsWith("-") || /\s/.test(host)) {
    return { ok: false, error: `"${host}" is not an ssh host name.` };
  }
  const rootPath = input.rootPath.trim().replace(/\\/g, "/").replace(/\/+$/, "") || input.rootPath.trim().replace(/\\/g, "/");
  if (!rootPath) return { ok: false, error: "Name the workspace's root folder on the host." };
  if (!/^(\/|[A-Za-z]:\/)/.test(rootPath)) {
    return {
      ok: false,
      error: "The root must be an absolute path on the host — /home/me/repo, or C:/Users/me/repo on Windows.",
    };
  }
  const daemonPath = input.daemonPath.trim();
  if (daemonPath.includes('"')) {
    return { ok: false, error: "The daemon path cannot contain a double quote — no host shell can carry one." };
  }
  const ssh: SshConfig = daemonPath ? { host, daemonPath } : { host };
  return { ok: true, ssh, rootPath };
}
