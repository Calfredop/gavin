//! The host's registered Tauri command names (companion-13).
//!
//! Kept equal to the `generate_handler!` list in `lib.rs` and to the keys of
//! `protocol::remote_command_table`. The completeness tests fail when either
//! side drifts: adding a command without a Remote-role table entry, or
//! updating the table without registering the command, both break the build.

/// Every command registered with `tauri::generate_handler!` in `lib.rs`.
pub const REGISTERED_COMMANDS: &[&str] = &[
    "write_input",
    "resize_session",
    "create_session",
    "kill_session",
    "adopt_session",
    "snapshot_session",
    "session_screen",
    "typesafe_settings",
    "set_typesafe_enabled",
    "set_typesafe_api_key",
    "typesafe_verdict",
    "set_typesafe_change_attribution",
    "typesafe_attribution",
    "set_failure_patterns",
    "distrust_osc133",
    "get_workspaces_state",
    "set_workspaces_state",
    "get_workspace_settings",
    "set_workspace_settings",
    "add_workspace",
    "get_theme_pref",
    "set_theme_pref",
    "get_terminal_font_size",
    "set_terminal_font_size",
    "get_auto_commit",
    "set_auto_commit",
    "get_git_tracking_default",
    "set_git_tracking_default",
    "get_require_review",
    "set_require_review",
    "get_headroom_default",
    "set_headroom_default",
    "set_headroom_workspaces",
    "get_headroom_status",
    "headroom_savings",
    "headroom_reach",
    "detect_headroom",
    "install_headroom",
    "get_memory_index",
    "ensure_memory_index",
    "get_session_names",
    "set_session_name",
    "get_file_tabs",
    "set_file_tabs",
    "attachment_status",
    "read_file_for_viewer",
    "resolve_path_under_cursor",
    "viewable_extensions",
    "watch_file_for_viewer",
    "unwatch_file_for_viewer",
    "write_file_for_editor",
    "list_directory",
    "create_file",
    "create_directory",
    "rename_path",
    "trash_entry",
    "open_path_externally",
    "reveal_path_externally",
    "signal_frontend_ready",
    "set_companion_attention",
    "title_bar_double_click_action",
    "get_bootstrap_error",
    "restart_daemon",
    "stop_daemon",
    "get_require_local_token",
    "set_require_local_token",
    "begin_pairing",
    "confirm_pairing",
    "reject_pairing",
    "list_devices",
    "get_relay_state",
    "revoke_device",
    "revoke_all_devices",
    "set_remote_access",
    "set_push_gateway_url",
    "push_companion_notify",
    "daemon_compat",
    "open_confirmation",
    "answer_confirmation",
    "get_board",
    "card_session",
    "card_runs",
    "set_board",
    "get_orchestration",
    "set_orchestration",
    "set_rail_run",
    "set_step_run",
    "get_tools",
    "save_tool",
    "delete_tool",
    "start_tool_run",
    "set_tool_run_outcome",
    "tool_runs",
    "get_group_templates",
    "save_group_template",
    "delete_group_template",
    "delete_board",
    "watch_gavin_root",
    "unwatch_gavin_root",
    "get_gavin_tree",
    "init_gavin_root",
    "create_gavin_context",
    "add_external_gavin_context",
    "remove_external_gavin_context",
    "gavin_root_exists",
    "connect_remote_workspace",
    "get_board_tabs",
    "get_card_tabs",
    "get_session_baselines",
    "end_orphan",
    "list_managed_sessions",
    "queue_input",
    "list_queued_inputs",
    "set_queued_inputs",
    "send_queued_input",
    "set_board_tabs",
    "set_card_tabs",
    "set_plan_frontmatter_field",
    "create_plan",
    "set_checklist_item",
    "file_human_item",
    "resolve_human_item",
    "delete_card_file",
    "archive_card",
    "unarchive_card",
    "link_card_session",
    "unlink_card_session",
    "promote_checklist_item",
    "set_root_config_field",
    "get_agent_model_defaults",
    "set_agent_model_default",
    "get_agent_skills_marks",
    "set_agent_skills_mark",
    "agent_skills_farewell",
    "dismiss_agent_skills_farewell",
    "agent_skills_status",
    "agent_skills_install",
    "playwright_status",
    "playwright_install",
    "watch_browser",
    "unwatch_browser",
    "watch_browser_for_device",
    "unwatch_browser_for_device",
    "list_browsers",
    "get_playwright_pane_open",
    "set_playwright_pane_open",
    "setup_agent_integration",
    "agent_profiles",
    "detect_agent_binaries",
    "agent_model_catalog",
    "agent_usage",
    "system_memory",
    "watchman_status",
    "watchman_forget",
    "gavin_memory",
    "pr_status",
    "card_run_tokens",
    "conversation_log",
    "get_launch_config",
    "set_launch_config",
    "get_custom_resume_args",
    "set_custom_resume_args",
    "get_agent_defaults",
    "set_agent_defaults",
    "mcp_formats",
    "move_agent_file",
    "compose_agent_prompt",
    "open_workspace_window",
    "workspace_windows",
    "claim_workspace_window",
    "focus_workspace_window",
    "close_all_workspace_windows",
    "close_workspace_window",
    "app_duty",
    "hide_to_menu_bar",
    "set_sleep_hold",
    "scan_gavin_footprint",
    "remove_gavin_footprint",
    "git_repo_info",
    "gavin_git_tracking",
    "set_gavin_git_tracking",
    "git_status",
    "get_git_baselines",
    "git_diff",
    "git_head_sha",
    "git_run_changes",
    "git_diff_since",
    "git_discard_run",
    "git_stage_files",
    "git_unstage_files",
    "git_stage_all",
    "git_unstage_all",
    "git_apply_patch",
    "git_discard_files",
    "git_commit",
    "agent_commit_for_device",
    "answer_agent_commit_request",
    "git_init",
    "git_watch",
    "git_unwatch",
    "git_refs",
    "git_fetch",
    "git_pull",
    "git_push",
    "git_cancel_op",
    "git_checkout",
    "git_create_branch",
    "git_delete_branch",
    "git_merged_branches",
    "git_merge",
    "git_abort_in_progress",
    "git_continue_rebase",
    "git_add_remote",
    "git_remove_remote",
    "git_stash_push",
    "git_stash_pop",
    "git_stash_apply",
    "git_stash_drop",
    "git_stash_files",
    "git_worktree_add",
    "git_worktree_remove",
    "git_worktree_prune",
    "git_log",
    "git_commit_detail",
    "git_checkout_commit",
    "git_cherry_pick",
    "git_revert",
    "git_reset",
    "git_continue_in_progress",
    "git_conflict",
    "git_mark_resolved",
    "git_resolve_whole",
    "git_resolve_deleted",
    "git_restore_conflict",
    "git_merge_tool_name",
    "git_read_ignore_file",
    "git_write_ignore_file",
    "git_add_ignore_pattern",
    "worktree_setup",
    "update_settings",
    "set_update_endpoint",
    "check_for_update",
    "install_update",
    "temp_dir",
    "home_dir",
];

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{allowance_for, remote_command_table};
    use std::collections::HashSet;

    /// The key test (ADR 0003 / seam 3): the Remote role table's keys equal
    /// the host's registered command set, so a new command without an entry
    /// fails here rather than shipping as an invisible gap.
    #[test]
    fn remote_command_table_keys_equal_registered_commands() {
        let registered: HashSet<&str> = REGISTERED_COMMANDS.iter().copied().collect();
        let table: HashSet<&str> = remote_command_table().iter().map(|(n, _)| *n).collect();
        let missing: Vec<_> = registered.difference(&table).copied().collect();
        let extra: Vec<_> = table.difference(&registered).copied().collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "registered but missing from remote_command_table: {missing:?};\n             in the table but not registered: {extra:?}"
        );
        // Sanity: every registered name has an allowance (Allowed or Refused).
        for name in REGISTERED_COMMANDS {
            assert!(allowance_for(name).is_some(), "{name} has no allowance");
        }
    }

    /// REGISTERED_COMMANDS is maintained by hand next to `generate_handler!`.
    /// Parse the handler list from lib.rs so forgetting to update this array
    /// when adding a command fails the suite.
    #[test]
    fn registered_commands_match_generate_handler_list() {
        let src = include_str!("lib.rs");
        let start = src
            .find("generate_handler![")
            .expect("generate_handler! in lib.rs");
        let after = &src[start + "generate_handler![".len()..];
        let end = after.find(']').expect("closing ] of generate_handler!");
        let body = &after[..end];
        let mut parsed = Vec::new();
        for part in body.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let name = part.rsplit("::").next().unwrap().trim();
            if !name.is_empty() {
                parsed.push(name);
            }
        }
        assert_eq!(
            parsed.as_slice(),
            REGISTERED_COMMANDS,
            "REGISTERED_COMMANDS drifted from generate_handler! — update commands.rs"
        );
    }
}
