---
title: App hub
status: Done
---
A centralized hub with recent workspaces, new workspace shortcut (with
wizard), link to github repo, link to site… A là vscode new window ux

Gavin has one window and the pinned workspace always exists, so there is
no "nothing open" moment to hang a welcome page on. The hub is instead a
pinned app-level row above **Workspaces** in the sidebar that takes over
the main pane — reachable with a workspace open, not only without one.

Decided:
- Recents are workspaces ordered by last use, each row carrying its root
  path and a live recap. That is what earns the hub its place over the
  sidebar list sitting right below it: a fleet overview, not a copy.
- "New workspace" drives the sidebar's existing path verbatim (name →
  WorkspaceCreateModal → SetupWizard). One creation path, so two entry
  points cannot drift apart.
- Links are Gavin's own repo and issues. The site link does not render
  until there is a URL for it — no dead link ships.

Assumed unless overruled:
- Workspaces live in the Tauri host's config.json, not the daemon, so
  this needs no PROTOCOL_VERSION bump and no FEATURE_MIN_VERSION gate.
- The hub is not persisted: a relaunch lands where you left off.
- Scratchpad appears in recents like any other workspace.

Out of scope: a keyboard shortcut for the hub, a folder-first "Open
folder…", per-workspace repo links, changing what a workspace is.

- [x] Rename the pinned workspace "Unfiled" → "Scratchpad": the seed
      string in session.rs, plus a bootstrap migration renaming the
      persisted one where it still reads "Unfiled". UNFILED_WORKSPACE_ID
      stays "__unfiled__" — changing the id orphans every existing
      config. Verified by launching against an existing config.json.
- [x] Workspace.lastActiveAt (epoch ms, optional) in config.rs with
      #[serde(default)] and in workspace.ts; switchWorkspace takes a
      `now` and stamps it. An existing config loads with it absent and
      nothing breaks.
- [x] appHub.ts + tests: recentWorkspaces() (stamped newest-first,
      never-switched after them in sidebar order), relativeTime(), and
      APP_LINKS with the website entry omitted while its URL is null.
- [x] workspaceAgentsSummary() in sidebarSummary.ts + tests: sums
      pageAgentsSummary over the workspace's pages and folds in
      mainSessionId, so a hub row's "2 running · 4 pages" can never
      disagree with the sidebar's own per-page recap.
- [x] AppHubView.svelte — a thin template over those two modules:
      version header, recent rows (name · recap · root · relative time),
      "+ New workspace…", and the links footer via openUrl.
- [x] Route it: an appHubOpen store in layoutState.ts, rendered in
      +page.svelte ahead of the workspace branches. Switching to any
      workspace clears it.
- [x] The sidebar's pinned "Gavin" row above the Workspaces header,
      highlighted while the hub is showing.
- [x] Lift startCreatingWorkspace + the WorkspaceCreateModal handoff out
      of Sidebar.svelte so the hub button and the sidebar + call one
      implementation, not two.
- [x] Green: cargo test --workspace, and in app/ npm test && npm run
      check && npm run build.
- [x] Smoke items in smokeChecklist.ts: the hub row opens it, switching
      workspaces reorders recents, New workspace reaches the wizard, and
      both links open in the browser.
