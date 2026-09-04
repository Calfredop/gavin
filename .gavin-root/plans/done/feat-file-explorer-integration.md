---
order: 2048
title: [feat] file explorer integration
status: Done
---
In something like vscode and cursor do, I would like to implement a file
explorer with basic editing features. Editing already exists — `FileEditor` +
`fileEditing.ts` give any text file `plain`/`edit` modes (markdown also gets
`formatted`), with autosave and a conflict tracker. What is missing is the
tree: `PlanTree` is fed by the daemon's `.gavin*` watcher and shows only
Plans/Docs/Specs/Archive, and no repo-wide directory listing exists anywhere
in the host.

So this is a new **Files** hub tab, sibling of Plans, with the same two-pane
shape: a lazy directory tree over the workspace root on the left, the existing
`FileEditor` on the right.

Decisions taken — do not re-derive:

- The tree shows **everything on disk** — no `.gitignore` filter, no dotfile
  hiding. `target/` and `node_modules/` therefore sit at the top level; that is
  fine because a directory is listed only when expanded.
- **Lazy expansion**, one `read_dir` per opened directory. Never a recursive
  walk and never a watcher on the repo tree — a 3000-folder repo took minutes
  to arm an FSEvents stream and stalled the streaming thread. The tree
  refreshes on demand and after its own mutations.
- **No daemon and no protocol change.** `PROTOCOL_VERSION` stays 29, exactly as
  the file viewer spec settled it: reading and writing files is the Tauri
  host's job.

- [x] Host: `list_directory(path)` in `fileviewer.rs` returning name / is_dir /
      size / symlink for one directory's entries, refusing any path outside the
      workspace root and never following a symlinked directory. Unit tests over
      a tempdir.
- [x] Host: the mutations — `create_file`, `create_directory`, `rename_path`,
      and delete via the **existing** `trash_path` in `workspace_delete.rs`
      (reuse it; do not add a second trash route — its default macOS path
      drives Finder at ~13s a call). Each refuses a path outside the root and
      refuses to clobber an existing entry. Unit tests for the refusals, not
      just the happy path.
- [x] `fileTree.ts` — the pure module: node model, expand/collapse,
      directories-before-files name sort, and reconciling a node after a
      create/rename/delete without re-reading the whole tree. Unit tests here;
      the component stays a thin template over it.
- [x] `FilesHubView.svelte` plus a `{ id: "files", label: "Files",
      requiresRoot: true }` entry in `hubViewMeta.ts`, after `plans`. Tree
      left, the existing `FileEditor` right, the split stored as a **share**
      not a px width.
- [x] Selection and expansion survive a tab switch. `+page.svelte` destroys a
      hub view on every switch, so this goes in `localStorage` per workspace
      like `selectionStorageKey`, and is verified against the tree on restore.
- [x] A filename filter box above the tree: narrows to rows whose name contains
      the query, keeping a matched file's ancestor directories visible. It
      filters **loaded** nodes only — a recursive walk to find unloaded matches
      is exactly the trap the lazy tree exists to avoid — so its empty state
      says "no match in the folders you have opened", never a bare "no match".
      Lives in `fileTree.ts` with unit tests.
- [x] Row actions: click opens in the editor pane; "Open in a tab" hands the
      path to the existing file-tab route; a type outside `viewable_extensions`
      opens in the OS default app instead; plus Copy path and Reveal in Finder.
- [x] Context-menu mutations: New file, New folder, Rename, Move to Trash.
      Every prompt goes through `askConfirm` / `ConfirmPrompt` from `dialog.ts`
      — plugin-dialog is capability-narrowed and its `confirm` fails at the
      permission layer. Trash is a `danger` choice, so focus stays on the
      dismissing button.
- [x] A mutation reconciles what is open: a rename retargets any file tab or
      editor holding the old path; a delete leaves the editor showing its
      buffer under the existing "deleted" banner rather than discarding unsaved
      text.
- [x] Suites green — `cargo test --workspace`, and in `app/`: `npm test && npm
      run check && npm run build`.
- [x] Add the Files tab's manual passes to `smokeChecklist.ts`: the tree opens
      over the root, expanding a large directory stays responsive, each
      mutation, and a rename under an open tab.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
