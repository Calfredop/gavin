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

const RUST = import.meta.glob("../../../src-tauri/src/*.rs", {
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
  confirm_pairing: [
    "gated",
    "the one command that WIDENS who reaches this machine. With a transport (ticket 10) a script in the page can run the whole ceremony -- set_remote_access, begin_pairing, its own Device, confirm_pairing -- and the six digits only protect a confirmation a human makes. The subject is the device_id AND the six digits, so a token for one pairing cannot confirm another. Still a page-drawn prompt: a script that knows gavin can open and answer it itself (confirm_gate.rs); closing that takes a host-drawn confirmation, filed as 06-companion Q15.",
  ],
  trash_entry: ["gated", "moves a file out of the workspace"],
  delete_card_file: ["gated", "removes a card from the board and from disk"],
  remove_gavin_footprint: ["gated", "empties a workspace of gavin, through the delete wizard"],
  restart_daemon: ["gated", "pkills a daemon shared with every other gavin window"],
  stop_daemon: [
    "gated",
    "the same daemon as restart_daemon and the same shared reach, minus the half that brings it back: this one leaves every session ended and nothing listening. It is the close prompt's bottom rung, and the rung IS the confirmation the host mints from.",
  ],
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
  // Remote access. `confirm_pairing` is gated, above, for the reason
  // written there: it is the only command here that can widen who reaches
  // this machine, and ticket 10's transport removed the reason it was
  // ordinary in phase 2 ("nothing can reach the state it settles").
  //
  // `begin_pairing` stays ordinary. It mints a two-minute secret and
  // returns the QR, and reaches nothing on its own: a paired row needs
  // the confirmation, which is now gated. It cannot be gated without
  // buying nothing -- the desk must draw the QR, so the page has to be
  // able to read it, and a token a script can mint itself protects
  // nothing more than the page-drawn confirmation already does.
  //
  // `set_remote_access` stays ordinary, by this table's own line (it
  // removes no work and ends no process) and because choosing a Relay is
  // step 1 of an attack that cannot finish without step 4: a Relay of the
  // script's choosing is handed no admission token (the daemon forgets it
  // when the URL changes; `list_devices` says only whether one is set),
  // and a Device that pairs through it still needs `confirm_pairing`.
  // The token itself IS readable by the page, through the QR that
  // `begin_pairing` returns -- that is what a QR is for. Gating the
  // switch would also gate the toggle that turns remote access OFF.
  //
  // `reject_pairing` and `list_devices` only narrow or read.
  begin_pairing: ["ordinary"],
  reject_pairing: ["ordinary"],
  list_devices: ["ordinary"],
  // A read of the dial's state; the admission token is in no answer.
  get_relay_state: ["ordinary"],
  set_remote_access: ["ordinary"],

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
  revoke_device: [
    "destructive",
    "the same shape as delete_tool: it removes a stored record gavin cannot bring back. Re-pairing MAKES a device, it does not restore this one, and the daemon drops the device's live connections on the way. Not gated, because it only ever NARROWS what can reach this machine -- a script that called it by surprise would be a nuisance, never an escalation, and a revocation that is hard to reach is the wrong failure to design for.",
  ],
  revoke_all_devices: [
    "destructive",
    "revoke_device for every row, plus a rotation of the daemon's static key -- the half that is irreversible in the strong sense, because the old key is gone and every phone pinned it. Deliberately not gated for revoke_device's reason, and more so: this is §3's one-button answer to a lost phone, and a confirmation the host has to mint is a hurdle in front of the one control whose whole job is to be reachable in a hurry. The app confirms it on every route (revokeAllCopy).",
  ],

  // ---- ordinary ----
  write_input: ["ordinary"],
  resize_session: ["ordinary"],
  create_session: ["ordinary"],
  adopt_session: ["ordinary"],
  snapshot_session: ["ordinary"],
  set_failure_patterns: ["ordinary"],
  distrust_osc133: ["ordinary"],
  get_workspaces_state: ["ordinary"],
  set_workspaces_state: ["ordinary"],
  get_workspace_settings: ["ordinary"],
  set_workspace_settings: ["ordinary"],
  add_workspace: ["ordinary"],
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
  // The compression switch. The default is a setting like the ones
  // around it. `set_headroom_workspaces` tells the daemon which
  // workspaces have compression on, and the daemon starts or stops
  // Headroom to match -- a process, which is why it is worth a line.
  // Ordinary all the same: what it can end is a proxy gavin restarts on
  // the same port, and what that costs a running agent is one retried
  // request. No work is removed, and turning the switch back undoes it.
  get_headroom_default: ["ordinary"],
  set_headroom_default: ["ordinary"],
  set_headroom_workspaces: ["ordinary"],
  // Headroom's setup surfaces. The status and Check again/Locate… read
  // and look. The install writes a uv tool into the human's home and
  // fetches a model; as Update it also restarts the proxy on its port,
  // which costs a running agent one retried request -- the same trade as
  // the switch above, and Settings asks before it. Nothing is removed.
  get_headroom_status: ["ordinary"],
  // The hub's savings in a limit window: a read of snapshots the daemon
  // already took.
  headroom_savings: ["ordinary"],
  headroom_reach: ["ordinary"],
  detect_headroom: ["ordinary"],
  install_headroom: ["ordinary"],
  // Adopted memories: the index's state, and bringing it up to the
  // instructions file -- derived data, rebuilt from the file at will.
  // The one cost is a model download the Memory step asks for.
  get_memory_index: ["ordinary"],
  ensure_memory_index: ["ordinary"],
  get_session_names: ["ordinary"],
  set_session_name: ["ordinary"],
  get_file_tabs: ["ordinary"],
  set_file_tabs: ["ordinary"],
  attachment_status: ["ordinary"],
  read_file_for_viewer: ["ordinary"],
  resolve_path_under_cursor: ["ordinary"],
  viewable_extensions: ["ordinary"],
  temp_dir: ["ordinary"],
  home_dir: ["ordinary"],
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
  set_companion_attention: ["ordinary"],
  title_bar_double_click_action: ["ordinary"],
  get_bootstrap_error: ["ordinary"],
  daemon_compat: ["ordinary"],
  open_confirmation: ["ordinary"],
  answer_confirmation: ["ordinary"],
  get_board: ["ordinary"],
  card_session: ["ordinary"],
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
  // Opens the ssh connection to the host a workspace already names --
  // the Reconnect button, and the first connect after a workspace is made
  // an ssh one. Ordinary: the host it reaches is the one already in the
  // workspace list, put there through the ssh modal, and a failed connect
  // removes nothing. It is not a way to name a NEW host.
  connect_remote_workspace: ["ordinary"],
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
  // Filing a question or a hands-on check on a card, and writing the
  // human's answer back under it. Both are ordinary card writes: one
  // appends a checklist line, the other adds a line beneath one and
  // ticks a box. Nothing is run and nothing of the human's is lost --
  // and the second is only ever sent on a press they made.
  file_human_item: ["ordinary"],
  resolve_human_item: ["ordinary"],
  unarchive_card: ["ordinary"],
  link_card_session: ["ordinary"],
  unlink_card_session: ["ordinary"],
  promote_checklist_item: ["ordinary"],
  set_root_config_field: ["ordinary"],
  get_agent_model_defaults: ["ordinary"],
  set_agent_model_default: ["ordinary"],
  get_agent_skills_marks: ["ordinary"],
  set_agent_skills_mark: ["ordinary"],
  // The Settings note about the plugin gavin used to recommend: a read of
  // config.json, and a write of one root into it.
  agent_skills_farewell: ["ordinary"],
  dismiss_agent_skills_farewell: ["ordinary"],
  agent_skills_status: ["ordinary"],
  agent_skills_install: ["ordinary"],
  // The Playwright step: three checks, and an install of the pinned
  // browser plus a `playwright` entry merged into the agent's MCP config
  // -- the same kind of write as setup_agent_integration's below. The
  // install runs `npx` with fixed arguments outside the workspace, so no
  // repository chooses what it runs.
  playwright_status: ["ordinary"],
  playwright_install: ["ordinary"],
  // The live view of an agent's browser: a stream to the asking window,
  // its read-back, and the app-wide pane setting.
  watch_browser: ["ordinary"],
  unwatch_browser: ["ordinary"],
  watch_browser_for_device: ["ordinary"],
  unwatch_browser_for_device: ["ordinary"],
  list_browsers: ["ordinary"],
  get_playwright_pane_open: ["ordinary"],
  set_playwright_pane_open: ["ordinary"],
  setup_agent_integration: ["ordinary"],
  agent_profiles: ["ordinary"],
  // A read: which agent CLIs resolve on PATH. It spawns none of them.
  detect_agent_binaries: ["ordinary"],
  agent_model_catalog: ["ordinary"],
  agent_usage: ["ordinary"],
  pr_status: ["ordinary"],
  card_run_tokens: ["ordinary"],
  // A read: whether the transcript for a conversation id is on disk, off
  // the same resolver card_run_tokens reads through. It writes nothing and
  // reaches nothing but files the CLI wrote on this machine.
  conversation_log: ["ordinary"],
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
  // A resume flag, the same shape as the launch wall above: a
  // preference read and write, ordinary because nothing of the human's
  // is lost or run by setting it.
  get_custom_resume_args: ["ordinary"],
  set_custom_resume_args: ["ordinary"],
  // Three reads -- a memory sample from the OS, whether a watchman is
  // running, and what Gavin's own processes hold. `watchman_forget` is
  // the odd one and still ordinary: it is `watch-del` on one root, and
  // watchman re-establishes the watch the next time something asks.
  // Nothing of the human's is lost, which is the line this table draws
  // for `destructive`.
  system_memory: ["ordinary"],
  watchman_status: ["ordinary"],
  gavin_memory: ["ordinary"],
  watchman_forget: ["ordinary"],
  mcp_formats: ["ordinary"],
  move_agent_file: ["ordinary"],
  compose_agent_prompt: ["ordinary"],
  // TypeSafe: the session screen as text (a read), the two switches and
  // the key (settings writes -- the key never comes back), and two
  // outbound questions the host adds the key to. None touches the
  // checkout or the daemon's state.
  session_screen: ["ordinary"],
  typesafe_settings: ["ordinary"],
  set_typesafe_enabled: ["ordinary"],
  set_typesafe_api_key: ["ordinary"],
  typesafe_verdict: ["ordinary"],
  set_typesafe_change_attribution: ["ordinary"],
  typesafe_attribution: ["ordinary"],
  open_workspace_window: ["ordinary"],
  workspace_windows: ["ordinary"],
  claim_workspace_window: ["ordinary"],
  focus_workspace_window: ["ordinary"],
  close_workspace_window: ["ordinary"],
  close_all_workspace_windows: ["ordinary"],
  app_duty: ["ordinary"],
  hide_to_menu_bar: ["ordinary"],
  set_sleep_hold: ["ordinary"],
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
  git_read_ignore_file: ["ordinary"],
  git_write_ignore_file: ["ordinary"],
  git_add_ignore_pattern: ["ordinary"],
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
