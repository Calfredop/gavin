// What the app hub shows: the recents list, the age stamp beside each
// row, and the outbound links in the footer. Pure functions over data
// the app already holds -- AppHubView.svelte is a template over this
// module and holds no rules of its own.

import { sidebarWorkspaceOrder, type Workspace } from "./workspace";
import type { WorkspaceAgentsSummary } from "./sidebarSummary";
// Build-time, not a Tauri round trip: the hub's header must render on
// the very first frame, and a version is not worth an IPC failure mode.
// Keep in step with app/src-tauri/tauri.conf.json's own `version`, which
// is what the packaged app reports to the OS.
import { version } from "../../package.json";

export const APP_VERSION: string = version;

/// Workspaces in "most recently used first" order.
///
/// Two groups, never interleaved: everything with a `lastActiveAt`
/// stamp, newest first, then everything without one in the sidebar's own
/// order. An unstamped workspace is not "infinitely old" -- it is a
/// workspace this build has never seen switched to, which is a different
/// thing, and sorting it by a made-up zero would shuffle a fresh
/// install's list into reverse-creation order the first time the hub
/// opened. Falling back to sidebarWorkspaceOrder means the hub and the
/// sidebar list right below it agree until the stamps say otherwise.
///
/// Ties keep sidebar order for the same reason: two workspaces stamped
/// in the same millisecond is not information to sort on.
export function recentWorkspaces(workspaces: Workspace[]): Workspace[] {
  const ordered = sidebarWorkspaceOrder(workspaces);
  const stamped = ordered.filter((w) => typeof w.lastActiveAt === "number");
  const unstamped = ordered.filter((w) => typeof w.lastActiveAt !== "number");
  // Index into `ordered` breaks ties, so the sort stays deterministic
  // regardless of the engine's own stability guarantees.
  const rank = new Map(ordered.map((w, i) => [w.id, i]));
  stamped.sort((a, b) => {
    const diff = (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
    return diff !== 0 ? diff : (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  });
  return [...stamped, ...unstamped];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/// A short age for a hub row: "just now", "5m ago", "3h ago", "2d ago",
/// "6w ago". Coarse on purpose -- the row answers "which of these was I
/// in last", not "how long exactly", and a precise duration would only
/// make the column wider.
///
/// Null (never switched to) reads as "never", and so does a stamp in the
/// future: a clock that has moved backwards is the only way to get one,
/// and inventing "in 3 hours" for it would be worse than admitting the
/// app does not know.
export function relativeTime(then: number | null | undefined, now: number): string {
  if (typeof then !== "number") return "never";
  const delta = now - then;
  if (delta < 0) return "never";
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  return `${Math.floor(delta / WEEK)}w ago`;
}

export interface AppLink {
  id: string;
  label: string;
  /// Null means "there is nothing to link to yet". A link with a null
  /// url is never rendered -- see appLinks() -- because a dead link in
  /// the footer is worse than no link at all.
  url: string | null;
}

/// The hub's outbound links. Gavin's own repo and issues, plus a website
/// slot that stays null until there is a site: shipping a placeholder
/// that 404s would be the one thing this footer must not do. Fill the
/// url in and the row appears; nothing else has to change.
export const APP_LINKS: AppLink[] = [
  { id: "repo", label: "GitHub repository", url: "https://github.com/Calfredop/gavin" },
  { id: "issues", label: "Report an issue", url: "https://github.com/Calfredop/gavin/issues" },
  { id: "website", label: "Website", url: null },
];

/// The links that actually render, in declaration order.
export function appLinks(links: AppLink[] = APP_LINKS): AppLink[] {
  return links.filter((l) => l.url !== null);
}

/// The one-line recap beside a hub row: what is happening in that
/// workspace right now, then how much of it there is.
///
/// Built from workspaceAgentsSummary rather than from a count of its
/// own, so this line and the sidebar's per-page recaps underneath it
/// are the same arithmetic. Quiet buckets are omitted -- "0 running"
/// beside "0 waiting" is three words that say nothing -- which leaves a
/// resting workspace showing only its size.
export function workspaceRecapLine(summary: WorkspaceAgentsSummary): string {
  const parts: string[] = [];
  if (summary.running > 0) parts.push(`${summary.running} running`);
  if (summary.waiting > 0) parts.push(`${summary.waiting} waiting`);
  parts.push(summary.pages === 0 ? "no pages" : plural(summary.pages, "page"));
  return parts.join(" · ");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
