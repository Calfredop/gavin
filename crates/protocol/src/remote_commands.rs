//! The Remote role's command table (ADR 0003).
//!
//! The Companion drives the running desktop app: a Device asks the daemon
//! to invoke a Tauri command by name, and the daemon checks that name
//! here before forwarding. Both the daemon (which enforces) and the
//! desktop host (which tests completeness in companion-13) read this
//! table.
//!
//! An unknown name is refused -- `allowance_for` returns `None` -- so a
//! command that never registered, or one added on only one side of the
//! table, cannot slip through.

/// Whether the Remote role may invoke this desktop command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteAllowance {
    Allowed,
    Refused,
}

/// Every desktop command name and whether the Remote role may call it.
///
/// Keys must equal the host's registered command set (companion-13).
/// Refused covers Trust, layout-saving, window management, the updater,
/// opening things externally on the desk, and anything meaningless away
/// from the desk (`docs/superpowers/specs/2026-09-27-companion-design.md`).
pub fn remote_command_table() -> &'static [(&'static str, RemoteAllowance)] {
    &REMOTE_COMMAND_TABLE
}

/// What the table says about `command`, or `None` if the name is unknown.
pub fn allowance_for(command: &str) -> Option<RemoteAllowance> {
    REMOTE_COMMAND_TABLE
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, a)| *a)
}

const REMOTE_COMMAND_TABLE: &[(&str, RemoteAllowance)] = &[

    ("write_input", RemoteAllowance::Allowed),
    ("resize_session", RemoteAllowance::Allowed),
    ("create_session", RemoteAllowance::Allowed),
    ("kill_session", RemoteAllowance::Allowed),
    ("adopt_session", RemoteAllowance::Allowed),
    ("snapshot_session", RemoteAllowance::Allowed),
    ("session_screen", RemoteAllowance::Allowed),
    ("typesafe_settings", RemoteAllowance::Allowed),
    ("set_typesafe_enabled", RemoteAllowance::Allowed),
    ("set_typesafe_api_key", RemoteAllowance::Allowed),
    ("typesafe_verdict", RemoteAllowance::Allowed),
    ("set_typesafe_change_attribution", RemoteAllowance::Allowed),
    ("typesafe_attribution", RemoteAllowance::Allowed),
    ("set_failure_patterns", RemoteAllowance::Allowed),
    ("distrust_osc133", RemoteAllowance::Allowed),
    ("get_workspaces_state", RemoteAllowance::Allowed),
    ("set_workspaces_state", RemoteAllowance::Refused), // layout-saving
    // A workspace's settings, apart from its layout so a Device can change
    // one without the other (ADR 0006).
    ("get_workspace_settings", RemoteAllowance::Allowed),
    ("set_workspace_settings", RemoteAllowance::Allowed),
    // Adding one is Workstation data too: a workspace with no pages is
    // already a valid one at the desk, so a Device adds it as settings
    // alone rather than through the layout save it is refused.
    ("add_workspace", RemoteAllowance::Allowed),
    ("get_theme_pref", RemoteAllowance::Allowed),
    ("set_theme_pref", RemoteAllowance::Allowed),
    ("get_terminal_font_size", RemoteAllowance::Allowed),
    ("set_terminal_font_size", RemoteAllowance::Allowed),
    ("get_auto_commit", RemoteAllowance::Allowed),
    ("set_auto_commit", RemoteAllowance::Allowed),
    ("get_git_tracking_default", RemoteAllowance::Allowed),
    ("set_git_tracking_default", RemoteAllowance::Allowed),
    ("get_require_review", RemoteAllowance::Allowed),
    ("set_require_review", RemoteAllowance::Allowed),
    ("get_headroom_default", RemoteAllowance::Allowed),
    ("set_headroom_default", RemoteAllowance::Allowed),
    // The desk resolves every workspace's compression against the app-wide
    // default and tells the daemon, from the window holding the app's
    // duties -- which a Device never is. A Device moves the switch itself
    // through `set_workspace_settings`.
    ("set_headroom_workspaces", RemoteAllowance::Refused), // meaningless away from the desk
    ("get_headroom_status", RemoteAllowance::Allowed),
    // Adopted memories (v60). The status is a read; the ensure is what
    // Adopt calls after writing `### Learned`, which a Device can press.
    ("get_memory_index", RemoteAllowance::Allowed),
    ("ensure_memory_index", RemoteAllowance::Allowed),
    ("headroom_savings", RemoteAllowance::Allowed),
    ("headroom_reach", RemoteAllowance::Allowed),
    ("detect_headroom", RemoteAllowance::Allowed),
    ("install_headroom", RemoteAllowance::Allowed),
    ("get_session_names", RemoteAllowance::Allowed),
    ("set_session_name", RemoteAllowance::Allowed),
    ("get_file_tabs", RemoteAllowance::Allowed),
    ("set_file_tabs", RemoteAllowance::Refused), // layout-saving
    ("attachment_status", RemoteAllowance::Allowed),
    ("read_file_for_viewer", RemoteAllowance::Allowed),
    ("resolve_path_under_cursor", RemoteAllowance::Allowed),
    ("viewable_extensions", RemoteAllowance::Allowed),
    ("watch_file_for_viewer", RemoteAllowance::Allowed),
    ("unwatch_file_for_viewer", RemoteAllowance::Allowed),
    ("write_file_for_editor", RemoteAllowance::Allowed),
    ("list_directory", RemoteAllowance::Allowed),
    ("create_file", RemoteAllowance::Allowed),
    ("create_directory", RemoteAllowance::Allowed),
    ("rename_path", RemoteAllowance::Allowed),
    ("trash_entry", RemoteAllowance::Allowed),
    ("open_path_externally", RemoteAllowance::Refused), // open externally on the desk
    ("reveal_path_externally", RemoteAllowance::Refused), // open externally on the desk
    ("signal_frontend_ready", RemoteAllowance::Refused), // meaningless away from the desk
    ("set_companion_attention", RemoteAllowance::Refused), // desk publishes; Device asks GetAttention
    ("title_bar_double_click_action", RemoteAllowance::Refused), // window management
    ("get_bootstrap_error", RemoteAllowance::Refused), // meaningless away from the desk
    ("restart_daemon", RemoteAllowance::Refused), // meaningless away from the desk
    ("stop_daemon", RemoteAllowance::Refused), // meaningless away from the desk
    ("get_require_local_token", RemoteAllowance::Allowed),
    ("set_require_local_token", RemoteAllowance::Allowed),
    ("begin_pairing", RemoteAllowance::Refused), // Trust
    ("confirm_pairing", RemoteAllowance::Refused), // Trust
    ("reject_pairing", RemoteAllowance::Refused), // Trust
    ("list_devices", RemoteAllowance::Refused), // Trust
    ("get_relay_state", RemoteAllowance::Refused), // Trust: the desk's own dial
    ("revoke_device", RemoteAllowance::Refused), // Trust
    ("revoke_all_devices", RemoteAllowance::Refused), // Trust
    ("set_remote_access", RemoteAllowance::Refused), // Trust
    ("daemon_compat", RemoteAllowance::Allowed),
    ("open_confirmation", RemoteAllowance::Refused), // meaningless away from the desk
    ("answer_confirmation", RemoteAllowance::Refused), // meaningless away from the desk
    ("get_board", RemoteAllowance::Allowed),
    ("card_session", RemoteAllowance::Allowed),
    ("card_runs", RemoteAllowance::Allowed),
    ("set_board", RemoteAllowance::Allowed),
    ("get_orchestration", RemoteAllowance::Allowed),
    ("set_orchestration", RemoteAllowance::Allowed),
    ("set_rail_run", RemoteAllowance::Allowed),
    ("set_step_run", RemoteAllowance::Allowed),
    ("get_tools", RemoteAllowance::Allowed),
    ("save_tool", RemoteAllowance::Allowed),
    ("delete_tool", RemoteAllowance::Allowed),
    ("start_tool_run", RemoteAllowance::Allowed),
    ("set_tool_run_outcome", RemoteAllowance::Allowed),
    ("tool_runs", RemoteAllowance::Allowed),
    ("get_group_templates", RemoteAllowance::Allowed),
    ("save_group_template", RemoteAllowance::Allowed),
    ("delete_group_template", RemoteAllowance::Allowed),
    ("delete_board", RemoteAllowance::Allowed),
    ("watch_gavin_root", RemoteAllowance::Allowed),
    ("unwatch_gavin_root", RemoteAllowance::Allowed),
    ("get_gavin_tree", RemoteAllowance::Allowed),
    ("init_gavin_root", RemoteAllowance::Allowed),
    ("create_gavin_context", RemoteAllowance::Allowed),
    ("add_external_gavin_context", RemoteAllowance::Allowed),
    ("remove_external_gavin_context", RemoteAllowance::Allowed),
    ("gavin_root_exists", RemoteAllowance::Allowed),
    ("connect_remote_workspace", RemoteAllowance::Refused), // meaningless away from the desk
    ("get_board_tabs", RemoteAllowance::Allowed),
    ("get_card_tabs", RemoteAllowance::Allowed),
    ("get_session_baselines", RemoteAllowance::Allowed),
    ("end_orphan", RemoteAllowance::Allowed),
    ("list_managed_sessions", RemoteAllowance::Allowed),
    ("queue_input", RemoteAllowance::Allowed),
    ("list_queued_inputs", RemoteAllowance::Allowed),
    ("set_queued_inputs", RemoteAllowance::Allowed),
    ("send_queued_input", RemoteAllowance::Allowed),
    ("set_board_tabs", RemoteAllowance::Refused), // layout-saving
    ("set_card_tabs", RemoteAllowance::Refused), // layout-saving
    ("set_plan_frontmatter_field", RemoteAllowance::Allowed),
    ("create_plan", RemoteAllowance::Allowed),
    ("set_checklist_item", RemoteAllowance::Allowed),
    ("file_human_item", RemoteAllowance::Allowed),
    ("resolve_human_item", RemoteAllowance::Allowed),
    ("delete_card_file", RemoteAllowance::Allowed),
    ("archive_card", RemoteAllowance::Allowed),
    ("unarchive_card", RemoteAllowance::Allowed),
    ("link_card_session", RemoteAllowance::Allowed),
    ("unlink_card_session", RemoteAllowance::Allowed),
    ("promote_checklist_item", RemoteAllowance::Allowed),
    ("set_root_config_field", RemoteAllowance::Allowed),
    ("get_agent_model_defaults", RemoteAllowance::Allowed),
    ("set_agent_model_default", RemoteAllowance::Allowed),
    ("get_agent_skills_marks", RemoteAllowance::Allowed),
    ("set_agent_skills_mark", RemoteAllowance::Allowed),
    ("agent_skills_farewell", RemoteAllowance::Allowed),
    ("dismiss_agent_skills_farewell", RemoteAllowance::Allowed),
    ("agent_skills_status", RemoteAllowance::Allowed),
    ("agent_skills_install", RemoteAllowance::Allowed),
    // The Playwright setup step, like the agent skills step beside it.
    ("playwright_status", RemoteAllowance::Allowed),
    ("playwright_install", RemoteAllowance::Allowed),
    // The desk's live view of an agent's browser. The frames go to the
    // desk window that asked, at the desk's size; a phone asks for its own
    // small stream (`playwright-companion-view.md`), so these two mean
    // nothing away from the desk. The read-back and the setting do.
    ("watch_browser", RemoteAllowance::Refused), // meaningless away from the desk
    ("unwatch_browser", RemoteAllowance::Refused), // meaningless away from the desk
    // A Device's own view: the desk opens the session's stream at the
    // phone's size and rate, held by a lease the view renews, and offers
    // each frame to the Devices as `browser-frame`. The Device still sends
    // the daemon nothing of its own.
    ("watch_browser_for_device", RemoteAllowance::Allowed),
    ("unwatch_browser_for_device", RemoteAllowance::Allowed),
    ("list_browsers", RemoteAllowance::Allowed),
    ("get_playwright_pane_open", RemoteAllowance::Allowed),
    ("set_playwright_pane_open", RemoteAllowance::Allowed),
    ("setup_agent_integration", RemoteAllowance::Allowed),
    ("agent_profiles", RemoteAllowance::Allowed),
    ("detect_agent_binaries", RemoteAllowance::Allowed),
    ("agent_model_catalog", RemoteAllowance::Allowed),
    ("agent_usage", RemoteAllowance::Allowed),
    ("system_memory", RemoteAllowance::Allowed),
    ("watchman_status", RemoteAllowance::Allowed),
    ("watchman_forget", RemoteAllowance::Allowed),
    ("gavin_memory", RemoteAllowance::Allowed),
    ("pr_status", RemoteAllowance::Allowed),
    ("card_run_tokens", RemoteAllowance::Allowed),
    ("conversation_log", RemoteAllowance::Allowed),
    ("get_launch_config", RemoteAllowance::Allowed),
    ("set_launch_config", RemoteAllowance::Allowed),
    ("get_custom_resume_args", RemoteAllowance::Allowed),
    ("set_custom_resume_args", RemoteAllowance::Allowed),
    ("get_agent_defaults", RemoteAllowance::Allowed),
    ("set_agent_defaults", RemoteAllowance::Allowed),
    ("mcp_formats", RemoteAllowance::Allowed),
    ("move_agent_file", RemoteAllowance::Allowed),
    ("compose_agent_prompt", RemoteAllowance::Allowed),
    ("open_workspace_window", RemoteAllowance::Refused), // window management
    ("workspace_windows", RemoteAllowance::Refused), // window management
    ("claim_workspace_window", RemoteAllowance::Refused), // window management
    ("focus_workspace_window", RemoteAllowance::Refused), // window management
    ("close_all_workspace_windows", RemoteAllowance::Refused), // window management
    ("close_workspace_window", RemoteAllowance::Refused), // window management
    ("app_duty", RemoteAllowance::Refused), // window management
    ("hide_to_menu_bar", RemoteAllowance::Refused), // window management
    // The duty window holds the Mac awake while an agent runs; a Device
    // letting go of it would let the Mac sleep under its own connection.
    ("set_sleep_hold", RemoteAllowance::Refused), // meaningless away from the desk
    ("scan_gavin_footprint", RemoteAllowance::Refused), // meaningless away from the desk
    ("remove_gavin_footprint", RemoteAllowance::Refused), // meaningless away from the desk
    ("git_repo_info", RemoteAllowance::Allowed),
    ("gavin_git_tracking", RemoteAllowance::Allowed),
    ("set_gavin_git_tracking", RemoteAllowance::Allowed),
    ("git_status", RemoteAllowance::Allowed),
    ("get_git_baselines", RemoteAllowance::Allowed),
    ("git_diff", RemoteAllowance::Allowed),
    ("git_head_sha", RemoteAllowance::Allowed),
    ("git_run_changes", RemoteAllowance::Allowed),
    ("git_diff_since", RemoteAllowance::Allowed),
    ("git_discard_run", RemoteAllowance::Allowed),
    ("git_stage_files", RemoteAllowance::Allowed),
    ("git_unstage_files", RemoteAllowance::Allowed),
    ("git_stage_all", RemoteAllowance::Allowed),
    ("git_unstage_all", RemoteAllowance::Allowed),
    ("git_apply_patch", RemoteAllowance::Allowed),
    ("git_discard_files", RemoteAllowance::Allowed),
    ("git_commit", RemoteAllowance::Allowed),
    ("git_init", RemoteAllowance::Allowed),
    ("git_watch", RemoteAllowance::Allowed),
    ("git_unwatch", RemoteAllowance::Allowed),
    ("git_refs", RemoteAllowance::Allowed),
    ("git_fetch", RemoteAllowance::Allowed),
    ("git_pull", RemoteAllowance::Allowed),
    ("git_push", RemoteAllowance::Allowed),
    ("git_cancel_op", RemoteAllowance::Allowed),
    ("git_checkout", RemoteAllowance::Allowed),
    ("git_create_branch", RemoteAllowance::Allowed),
    ("git_delete_branch", RemoteAllowance::Allowed),
    ("git_merged_branches", RemoteAllowance::Allowed),
    ("git_merge", RemoteAllowance::Allowed),
    ("git_abort_in_progress", RemoteAllowance::Allowed),
    ("git_continue_rebase", RemoteAllowance::Allowed),
    ("git_add_remote", RemoteAllowance::Allowed),
    ("git_remove_remote", RemoteAllowance::Allowed),
    ("git_stash_push", RemoteAllowance::Allowed),
    ("git_stash_pop", RemoteAllowance::Allowed),
    ("git_stash_apply", RemoteAllowance::Allowed),
    ("git_stash_drop", RemoteAllowance::Allowed),
    ("git_stash_files", RemoteAllowance::Allowed),
    ("git_worktree_add", RemoteAllowance::Allowed),
    ("git_worktree_remove", RemoteAllowance::Allowed),
    ("git_worktree_prune", RemoteAllowance::Allowed),
    ("git_log", RemoteAllowance::Allowed),
    ("git_commit_detail", RemoteAllowance::Allowed),
    ("git_checkout_commit", RemoteAllowance::Allowed),
    ("git_cherry_pick", RemoteAllowance::Allowed),
    ("git_revert", RemoteAllowance::Allowed),
    ("git_reset", RemoteAllowance::Allowed),
    ("git_continue_in_progress", RemoteAllowance::Allowed),
    ("git_conflict", RemoteAllowance::Allowed),
    ("git_mark_resolved", RemoteAllowance::Allowed),
    ("git_resolve_whole", RemoteAllowance::Allowed),
    ("git_resolve_deleted", RemoteAllowance::Allowed),
    ("git_restore_conflict", RemoteAllowance::Allowed),
    ("git_merge_tool_name", RemoteAllowance::Allowed),
    ("git_read_ignore_file", RemoteAllowance::Allowed),
    ("git_write_ignore_file", RemoteAllowance::Allowed),
    ("git_add_ignore_pattern", RemoteAllowance::Allowed),
    ("worktree_setup", RemoteAllowance::Allowed),
    ("update_settings", RemoteAllowance::Refused), // updater
    ("set_update_endpoint", RemoteAllowance::Refused), // updater
    ("check_for_update", RemoteAllowance::Refused), // updater
    ("install_update", RemoteAllowance::Refused), // updater
    ("temp_dir", RemoteAllowance::Allowed),
    // Where a Device's folder browser starts when it adds a workspace.
    ("home_dir", RemoteAllowance::Allowed),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_unique() {
        let mut seen = std::collections::HashSet::new();
        for (name, _) in remote_command_table() {
            assert!(seen.insert(*name), "duplicate command name: {name}");
        }
    }

    #[test]
    fn trust_and_layout_commands_are_refused() {
        for name in [
            "begin_pairing",
            "confirm_pairing",
            "reject_pairing",
            "list_devices",
            "revoke_device",
            "revoke_all_devices",
            "set_remote_access",
            "set_workspaces_state",
            "set_file_tabs",
            "set_board_tabs",
            "set_card_tabs",
        ] {
            assert_eq!(allowance_for(name), Some(RemoteAllowance::Refused), "{name}");
        }
    }

    #[test]
    fn an_ordinary_read_is_allowed() {
        assert_eq!(allowance_for("get_board"), Some(RemoteAllowance::Allowed));
        assert_eq!(allowance_for("git_status"), Some(RemoteAllowance::Allowed));
    }

    /// ADR 0006: a workspace's settings are the Companion's to change, and
    /// its layout never is -- which is why the two are separate commands.
    #[test]
    fn workspace_settings_are_allowed_where_the_layout_is_refused() {
        assert_eq!(allowance_for("get_workspace_settings"), Some(RemoteAllowance::Allowed));
        assert_eq!(allowance_for("set_workspace_settings"), Some(RemoteAllowance::Allowed));
        assert_eq!(allowance_for("add_workspace"), Some(RemoteAllowance::Allowed));
        assert_eq!(allowance_for("set_workspaces_state"), Some(RemoteAllowance::Refused));
    }

    #[test]
    fn an_unknown_command_name_is_not_in_the_table() {
        assert_eq!(allowance_for("not_a_real_command"), None);
        assert_eq!(allowance_for(""), None);
    }

    #[test]
    fn window_updater_and_external_commands_are_refused() {
        for name in [
            "open_workspace_window",
            "close_workspace_window",
            "app_duty",
            "hide_to_menu_bar",
            "set_sleep_hold",
            "set_headroom_workspaces",
            "update_settings",
            "install_update",
            "open_path_externally",
            "reveal_path_externally",
        ] {
            assert_eq!(allowance_for(name), Some(RemoteAllowance::Refused), "{name}");
        }
    }
}

