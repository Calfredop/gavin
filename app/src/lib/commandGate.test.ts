import { describe, it, expect } from "vitest";
import { source } from "$lib/sources";

// The roll-call for `#[tauri::command]`.
//
// Every one of these is reachable from any script running in the app's
// own origin: Tauri's `core.js` defines `__TAURI_INTERNALS__` on every
// page whether or not `withGlobalTauri` is set, so `invoke` is available
// to whatever is in the document (AS-01/R5). Four of them now require a
// token the host mints from gavin's own confirmation
// (`confirm_gate.rs`), and the point of this file is that the four
// cannot quietly become three, and that a NEW command has to be looked
// at before it can ship.
//
// The mechanism is exhaustiveness: CLASSIFICATION below must name every
// command `lib.rs` registers, and only those. Add a command and this
// suite fails until somebody says which bucket it is in; remove one and
// it fails until the stale row goes. There is no default.
//
// The line for `destructive`: it removes work or ends a process, and
// gavin cannot bring it back. That is deliberately narrower than
// "writes something" -- the editor's own save overwrites a file too,
// and calling that destructive would flatten the distinction this table
// exists to keep.

const RUST = import.meta.glob("../../src-tauri/src/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function rust(file: string): string {
  const found = Object.entries(RUST).find(([path]) => path.endsWith(`/${file}`));
  if (!found) throw new Error(`${file} not found`);
  return found[1];
}

/// Every command name in `tauri::generate_handler![…]`, in registration
/// order, module prefix stripped.
function registeredCommands(): string[] {
  const list = rust("lib.rs").match(/tauri::generate_handler!\[([\s\S]*?)\]/);
  if (!list) throw new Error("no generate_handler! list in lib.rs");
  return list[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").at(-1) as string);
}

type Bucket = "gated" | "destructive" | "ordinary";

/// `[bucket, why]`. `why` is required for anything that is not ordinary
/// and is the record a future reader gets: for `destructive` it says why
/// the confirmation is not a capability there, and that reasoning is the
/// deliverable, not the label.
const CLASSIFICATION: Record<string, [Bucket, string?]> = {
  // ---- gated: the host refuses these without a confirmation token ----
  trash_entry: ["gated", "moves a file out of the workspace"],
  delete_card_file: ["gated", "removes a card from the board and from disk"],
  remove_gavin_footprint: ["gated", "empties a workspace of gavin, through the delete wizard"],
  restart_daemon: ["gated", "pkills a daemon shared with every other gavin window"],
  install_update: [
    "gated",
    "replaces the app bundle -- both sidecars with it -- and relaunches. The subject is the version, not a placeholder: the confirmation is for installing a particular release, and the host refuses the token if the endpoint has moved on.",
  ],
  // Reads. update_settings answers from the config and one small file;
  // check_for_update makes an HTTPS GET and reports what it found and
  // installs nothing. set_update_endpoint writes the URL this install
  // polls, which is not a trust decision -- the pinned key is, and no
  // command here can write one.
  update_settings: ["ordinary"],
  set_update_endpoint: ["ordinary"],
  check_for_update: ["ordinary"],
  // A read and a marker-file write for require_local_token. Ordinary: the
  // read is pure, and the write flips a daemon setting the daemon reads
  // per request -- it starts nothing and kills nothing, so it needs no
  // confirm grant, only the Remote access surface's own reach.
  get_require_local_token: ["ordinary"],
  set_require_local_token: ["ordinary"],

  // ---- destructive, deliberately not gated ----
  kill_session: [
    "destructive",
    "three callers have no human in the loop -- the app-quit sweep, the rollback after a failed multi-session spawn, and killing an agent session whose workspace has gone -- and a workspace with Close confirm off has none either. A gate those had to mint their own way past would be decorative.",
  ],
  end_orphan: [
    "destructive",
    "the same shape as kill_session: it ends a process. Confirmed on every route today (orphanActions.ts), so gating it is cheap -- but it belongs with kill_session, not ahead of it.",
  ],
  archive_card: [
    "destructive",
    "closes the card's live agent sessions. The card itself comes back with unarchive_card, so what is unrecoverable is the process, which is kill_session's question.",
  ],
  delete_board: ["destructive", "clears a workspace's columns and labels; the delete wizard's own last step"],
  delete_tool: ["destructive", "removes a stored rail tool"],
  delete_group_template: ["destructive", "removes a stored group template"],
  git_discard_run: ["destructive", "reset --hard over a run's changes"],
  git_discard_files: ["destructive", "throws away uncommitted work in the named files"],
  git_reset: ["destructive", "--hard loses the working tree"],
  git_abort_in_progress: ["destructive", "drops a merge or rebase and the conflict work in it"],
  git_restore_conflict: ["destructive", "puts the conflicted version back over an edited file"],
  git_resolve_whole: ["destructive", "writes one side of a conflict over the file"],
  git_resolve_deleted: ["destructive", "settles a delete/modify conflict by removing or keeping the file"],
  git_stash_pop: ["destructive", "applies and then drops the stash entry"],
  git_stash_drop: ["destructive", "drops a stash entry"],
  git_delete_branch: ["destructive", "deletes a ref"],
  git_worktree_remove: ["destructive", "removes a worktree directory"],

  // ---- ordinary ----
  write_input: ["ordinary"],
  resize_session: ["ordinary"],
  create_session: ["ordinary"],
  adopt_session: ["ordinary"],
  snapshot_session: ["ordinary"],
  set_failure_patterns: ["ordinary"],
  get_workspaces_state: ["ordinary"],
  set_workspaces_state: ["ordinary"],
  get_theme_pref: ["ordinary"],
  set_theme_pref: ["ordinary"],
  get_terminal_font_size: ["ordinary"],
  set_terminal_font_size: ["ordinary"],
  get_auto_commit: ["ordinary"],
  set_auto_commit: ["ordinary"],
  get_git_tracking_default: ["ordinary"],
  set_git_tracking_default: ["ordinary"],
  get_require_review: ["ordinary"],
  set_require_review: ["ordinary"],
  get_session_names: ["ordinary"],
  set_session_name: ["ordinary"],
  get_file_tabs: ["ordinary"],
  set_file_tabs: ["ordinary"],
  attachment_status: ["ordinary"],
  read_file_for_viewer: ["ordinary"],
  resolve_path_under_cursor: ["ordinary"],
  viewable_extensions: ["ordinary"],
  temp_dir: ["ordinary"],
  watch_file_for_viewer: ["ordinary"],
  unwatch_file_for_viewer: ["ordinary"],
  write_file_for_editor: ["ordinary"],
  list_directory: ["ordinary"],
  create_file: ["ordinary"],
  create_directory: ["ordinary"],
  rename_path: ["ordinary"],
  open_path_externally: ["ordinary"],
  reveal_path_externally: ["ordinary"],
  signal_frontend_ready: ["ordinary"],
  title_bar_double_click_action: ["ordinary"],
  get_bootstrap_error: ["ordinary"],
  daemon_compat: ["ordinary"],
  open_confirmation: ["ordinary"],
  answer_confirmation: ["ordinary"],
  get_board: ["ordinary"],
  card_runs: ["ordinary"],
  set_board: ["ordinary"],
  get_orchestration: ["ordinary"],
  set_orchestration: ["ordinary"],
  set_rail_run: ["ordinary"],
  set_step_run: ["ordinary"],
  get_tools: ["ordinary"],
  save_tool: ["ordinary"],
  start_tool_run: ["ordinary"],
  set_tool_run_outcome: ["ordinary"],
  tool_runs: ["ordinary"],
  get_group_templates: ["ordinary"],
  save_group_template: ["ordinary"],
  watch_gavin_root: ["ordinary"],
  unwatch_gavin_root: ["ordinary"],
  get_gavin_tree: ["ordinary"],
  init_gavin_root: ["ordinary"],
  create_gavin_context: ["ordinary"],
  add_external_gavin_context: ["ordinary"],
  remove_external_gavin_context: ["ordinary"],
  gavin_root_exists: ["ordinary"],
  get_board_tabs: ["ordinary"],
  get_card_tabs: ["ordinary"],
  get_session_baselines: ["ordinary"],
  list_managed_sessions: ["ordinary"],
  queue_input: ["ordinary"],
  list_queued_inputs: ["ordinary"],
  set_queued_inputs: ["ordinary"],
  send_queued_input: ["ordinary"],
  set_board_tabs: ["ordinary"],
  set_card_tabs: ["ordinary"],
  set_plan_frontmatter_field: ["ordinary"],
  create_plan: ["ordinary"],
  set_checklist_item: ["ordinary"],
  unarchive_card: ["ordinary"],
  link_card_session: ["ordinary"],
  unlink_card_session: ["ordinary"],
  promote_checklist_item: ["ordinary"],
  set_root_config_field: ["ordinary"],
  get_agent_model_defaults: ["ordinary"],
  set_agent_model_default: ["ordinary"],
  get_superpowers_marks: ["ordinary"],
  set_superpowers_mark: ["ordinary"],
  superpowers_status: ["ordinary"],
  superpowers_install: ["ordinary"],
  setup_agent_integration: ["ordinary"],
  agent_profiles: ["ordinary"],
  agent_model_catalog: ["ordinary"],
  agent_usage: ["ordinary"],
  pr_status: ["ordinary"],
  card_run_tokens: ["ordinary"],
  get_agent_pause: ["ordinary"],
  set_agent_pause: ["ordinary"],
  get_agent_defaults: ["ordinary"],
  set_agent_defaults: ["ordinary"],
  // The memory wall. A read and a preference write, the same shape as
  // the pause above -- and ordinary for the same reason, even though
  // `reclaim_done_sessions` is the one preference here that authorises a
  // process to be ended later. What ends it is `kill_session`, which is
  // on this table as destructive in its own right; calling the setting
  // that permits it destructive too would flatten the distinction
  // between doing a thing and consenting to it.
  get_launch_config: ["ordinary"],
  set_launch_config: ["ordinary"],
  // Two reads -- a memory sample from the OS, and whether a watchman is
  // running. `watchman_forget` is the odd one and still ordinary: it is
  // `watch-del` on one root, and watchman re-establishes the watch the
  // next time something asks. Nothing of the human's is lost, which is
  // the line this table draws for `destructive`.
  system_memory: ["ordinary"],
  watchman_status: ["ordinary"],
  watchman_forget: ["ordinary"],
  mcp_formats: ["ordinary"],
  move_agent_file: ["ordinary"],
  compose_agent_prompt: ["ordinary"],
  open_workspace_window: ["ordinary"],
  workspace_windows: ["ordinary"],
  claim_workspace_window: ["ordinary"],
  focus_workspace_window: ["ordinary"],
  close_workspace_window: ["ordinary"],
  scan_gavin_footprint: ["ordinary"],
  git_repo_info: ["ordinary"],
  gavin_git_tracking: ["ordinary"],
  set_gavin_git_tracking: ["ordinary"],
  git_status: ["ordinary"],
  get_git_baselines: ["ordinary"],
  git_diff: ["ordinary"],
  git_head_sha: ["ordinary"],
  git_run_changes: ["ordinary"],
  git_diff_since: ["ordinary"],
  git_stage_files: ["ordinary"],
  git_unstage_files: ["ordinary"],
  git_stage_all: ["ordinary"],
  git_unstage_all: ["ordinary"],
  git_apply_patch: ["ordinary"],
  git_commit: ["ordinary"],
  git_init: ["ordinary"],
  git_watch: ["ordinary"],
  git_unwatch: ["ordinary"],
  git_refs: ["ordinary"],
  git_fetch: ["ordinary"],
  git_pull: ["ordinary"],
  git_push: ["ordinary"],
  git_cancel_op: ["ordinary"],
  git_checkout: ["ordinary"],
  git_create_branch: ["ordinary"],
  git_merged_branches: ["ordinary"],
  git_merge: ["ordinary"],
  git_continue_rebase: ["ordinary"],
  git_add_remote: ["ordinary"],
  git_remove_remote: ["ordinary"],
  git_stash_push: ["ordinary"],
  git_stash_apply: ["ordinary"],
  git_stash_files: ["ordinary"],
  git_worktree_add: ["ordinary"],
  git_worktree_prune: ["ordinary"],
  git_log: ["ordinary"],
  git_commit_detail: ["ordinary"],
  git_checkout_commit: ["ordinary"],
  git_cherry_pick: ["ordinary"],
  git_revert: ["ordinary"],
  git_continue_in_progress: ["ordinary"],
  git_conflict: ["ordinary"],
  git_mark_resolved: ["ordinary"],
  git_merge_tool_name: ["ordinary"],
  worktree_setup: ["ordinary"],
};

const gatedIn = (bucket: Bucket) =>
  Object.entries(CLASSIFICATION)
    .filter(([, [b]]) => b === bucket)
    .map(([name]) => name)
    .sort();

describe("every registered command is classified", () => {
  it("names exactly the commands lib.rs registers", () => {
    const registered = registeredCommands().sort();
    const classified = Object.keys(CLASSIFICATION).sort();
    // Both directions, reported separately: "you added a command" and
    // "you removed one" are different jobs for whoever reads the failure.
    expect(registered.filter((c) => !classified.includes(c))).toEqual([]);
    expect(classified.filter((c) => !registered.includes(c))).toEqual([]);
  });

  it("gives every non-ordinary command a reason", () => {
    const missing = Object.entries(CLASSIFICATION)
      .filter(([, [bucket, why]]) => bucket !== "ordinary" && !why?.trim())
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });
});

describe("the gated set is the same set on both sides of the IPC", () => {
  it("matches confirm_gate.rs's GATED_ACTIONS", () => {
    const block = rust("confirm_gate.rs").match(
      /pub const GATED_ACTIONS: &\[&str\] = &\[([\s\S]*?)\];/
    );
    expect(block).not.toBeNull();
    const actions = [...(block as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(actions).toEqual(gatedIn("gated"));
  });

  it("matches confirmGate.ts's GatedAction union", () => {
    const gate = source("confirmGate.ts");
    const union = gate.match(/export type GatedAction =([\s\S]*?);/);
    expect(union).not.toBeNull();
    const members = [...(union as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(members).toEqual(gatedIn("gated"));
  });

  /// The entry in GATED_ACTIONS is only half a gate: the command has to
  /// spend the token too. Without this, adding a name to that list would
  /// look like protection and be none -- the same dead-gate shape
  /// `daemonCompat.ts`'s FEATURE_MIN_VERSION has when nothing consumes
  /// it.
  it("has every gated command actually spend a token", () => {
    const sources = Object.values(RUST).join("\n");
    for (const action of gatedIn("gated")) {
      // `async` is optional in the pattern: a command that reaches the
      // network -- install_update downloads before it installs -- has to
      // be async, and a spelling that only found the sync form reported
      // it as "has no body" rather than as the unguarded command the
      // check exists to catch.
      const body = sources.match(
        new RegExp(`pub (?:async )?fn ${action}\\(([\\s\\S]*?)\\n\\}`)
      );
      expect(body, `${action} has no body in src-tauri/src`).not.toBeNull();
      expect((body as RegExpMatchArray)[0]).toContain("confirm_gate::spend");
      expect((body as RegExpMatchArray)[0]).toContain("token: String");
    }
  });
});
