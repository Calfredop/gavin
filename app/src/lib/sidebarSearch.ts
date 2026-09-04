// The sidebar's search: one query over the three things the sidebar
// names -- workspaces, their pages, and the sessions inside those pages.
//
// The projection is pure so the ranking is testable without a component,
// which matters more here than on the other search boxes: the ORDER is
// the feature. A hit is ranked by what KIND of thing it is (workspace,
// then page, then session) before anything else, because the three form
// a containment hierarchy and the human searching "auth" almost always
// wants the workspace called auth rather than one of the nine sessions
// sitting in it. Within a kind, the sidebar's own order is kept, so a
// list of hits reads down the tree the same way the sidebar does.
//
// Matching itself is search.ts's, the same tokens-must-all-appear rule
// every other search box in the app runs on.

import { get, writable } from "svelte/store";
import { matchesFields, queryTokens } from "./search";
import { sessionLabel } from "./paths";
import { pageTabRows, type PageTabState } from "./sidebarSummary";
import type { SessionStatus } from "./layoutState";
import type { Workspace } from "./workspace";

/// Whether the search row is open under the title strip. A store rather
/// than component state because the button that opens it lives in
/// TitleBar.svelte and the input it opens lives in Sidebar.svelte --
/// two components, one answer.
export const sidebarSearchOpen = writable<boolean>(false);

/// What is typed. Kept beside the flag rather than inside the sidebar so
/// that closing the row is the one place that clears it: a query left
/// behind in component state would come back the next time the row was
/// opened, filtering a sidebar the human had already stopped searching.
export const sidebarSearchQuery = writable<string>("");

export function openSidebarSearch(): void {
  sidebarSearchOpen.set(true);
}

/// Closing always clears. A search row that reopened still filtered is
/// the one way this feature can hide a workspace from someone who is not
/// looking for anything.
export function closeSidebarSearch(): void {
  sidebarSearchOpen.set(false);
  sidebarSearchQuery.set("");
}

export function toggleSidebarSearch(): void {
  if (get(sidebarSearchOpen)) closeSidebarSearch();
  else openSidebarSearch();
}

export type SidebarHitKind = "workspace" | "page" | "session";

export interface SidebarHit {
  kind: SidebarHitKind;
  /// Unique across the whole result list, so `{#each}` can key on it --
  /// a page and the workspace holding it can otherwise collide on id in
  /// no other way, but a session appears under exactly one page and the
  /// kind prefix keeps that honest too.
  key: string;
  /// The name that matched.
  label: string;
  /// Where it sits, drawn after the label. Null for a workspace, which
  /// is already the top of the tree and has nothing above it to name.
  where: string | null;
  workspaceId: string;
  /// Null on a workspace hit; the page to switch to otherwise.
  pageId: string | null;
  /// Only a session hit names one.
  sessionId: string | null;
  /// The agent behind a session hit, so the row can wear the same badge
  /// the sidebar's own tab rows do. Null for the other two kinds.
  status: SessionStatus | null;
}

export interface SidebarSearchInput {
  /// Already in sidebar order, and already filtered to what the sidebar
  /// is willing to show -- a Scratchpad the human has switched off is
  /// not a place search may send them.
  workspaces: Workspace[];
  tabs: PageTabState;
  sessionNames: Record<string, string>;
  cwdBySessionId: Record<string, string>;
}

export interface SidebarSearchResult {
  /// At most `limit` of them, in rank order.
  hits: SidebarHit[];
  /// How many matched in total, so a truncated list can say so rather
  /// than quietly pretending the rest do not exist.
  total: number;
}

/// A blank query is not a search: it returns nothing rather than
/// everything, so an open-but-empty search row leaves the ordinary
/// workspace list on screen underneath it.
export const DEFAULT_SEARCH_LIMIT = 20;

export function searchSidebar(
  input: SidebarSearchInput,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT
): SidebarSearchResult {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return { hits: [], total: 0 };

  // Collected per kind and concatenated, rather than sorted afterwards
  // by a rank number: the order within a kind is "the order they were
  // walked in", and a comparator that had to preserve that would be a
  // stable-sort assumption where a concatenation is a fact.
  const workspaces: SidebarHit[] = [];
  const pages: SidebarHit[] = [];
  const sessions: SidebarHit[] = [];

  for (const ws of input.workspaces) {
    if (matchesFields(tokens, [ws.name])) {
      workspaces.push({
        kind: "workspace",
        key: `workspace:${ws.id}`,
        label: ws.name,
        where: null,
        workspaceId: ws.id,
        pageId: null,
        sessionId: null,
        status: null,
      });
    }
    for (const page of ws.pages) {
      if (matchesFields(tokens, [page.name])) {
        pages.push({
          kind: "page",
          key: `page:${page.id}`,
          label: page.name,
          where: ws.name,
          workspaceId: ws.id,
          pageId: page.id,
          sessionId: null,
          status: null,
        });
      }
      // Terminal tabs only. A file, board or card tab has no name of its
      // own to search -- its label is derived from a path or a card, and
      // those belong to the board's search, not to this one.
      for (const row of pageTabRows(page, input.tabs)) {
        if (row.kind !== "session") continue;
        const label = sessionLabel(input.sessionNames, input.cwdBySessionId, row.id);
        if (!matchesFields(tokens, [label])) continue;
        sessions.push({
          kind: "session",
          key: `session:${row.id}`,
          label,
          where: page.name,
          workspaceId: ws.id,
          pageId: page.id,
          sessionId: row.id,
          status: row.status,
        });
      }
    }
  }

  const all = [...workspaces, ...pages, ...sessions];
  return { hits: all.slice(0, limit), total: all.length };
}
