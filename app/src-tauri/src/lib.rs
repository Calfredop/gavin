mod agent_models;
mod agent_setup;
mod agent_tokens;
mod agent_usage;
mod config;
mod daemon;
mod edge_expand;
mod fileviewer;
mod git;
mod layout;
mod mac_window;
mod pull_request;
mod session;
mod superpowers;
mod trash;
mod workspace_delete;
mod workspace_window;
mod worktree_setup;

use tauri::{AppHandle, Emitter, Manager};

/// The frontend's read of the compat verdict Rust negotiated with the
/// daemon (session::verify_daemon_protocol, at both bootstrap and
/// reconnect). `None` before that first probe completes -- there is no
/// panicking equivalent of `session::current_compat` here on purpose: this
/// command is exactly what lets the frontend distinguish "not connected
/// yet" from "connected but degraded" instead of assuming one or crashing
/// on the other.
#[tauri::command]
fn daemon_compat(app_handle: AppHandle) -> Option<session::DaemonCompat> {
    *app_handle.state::<session::DaemonCompatState>().0.lock().unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .manage(session::FrontendReady(std::sync::atomic::AtomicBool::new(false)))
        .manage(session::BootstrapError(std::sync::Mutex::new(None)))
        .manage(session::ConnectionEpoch(std::sync::atomic::AtomicU64::new(0)))
        .manage(session::DaemonCompatState(std::sync::Mutex::new(None)))
        .manage(fileviewer::FileWatchers::default())
        .manage(git::GitWatchers::default())
        .manage(git::GitOps::default())
        .manage(agent_usage::UsageCache::new())
        .manage(pull_request::PrCache::new())
        .manage(agent_tokens::TokenCache::new())
        .manage(workspace_window::WorkspaceWindows::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                mac_window::round_window_corners(&window, 10.0);
                mac_window::install_edge_double_click(&window, 6.0);
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = session::bootstrap(handle.clone()) {
                    let message = e.to_string();
                    *handle.state::<session::BootstrapError>().0.lock().unwrap() = Some(message.clone());
                    let _ = handle.emit("daemon-error", message);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session::write_input,
            session::resize_session,
            session::create_session,
            session::kill_session,
            session::adopt_session,
            session::snapshot_session,
            session::set_failure_patterns,
            session::get_workspaces_state,
            session::set_workspaces_state,
            session::get_theme_pref,
            session::set_theme_pref,
            session::get_terminal_font_size,
            session::set_terminal_font_size,
            session::get_auto_commit,
            session::set_auto_commit,
            session::get_session_names,
            session::set_session_name,
            session::get_file_tabs,
            session::set_file_tabs,
            fileviewer::attachment_status,
            fileviewer::read_file_for_viewer,
            fileviewer::resolve_path_under_cursor,
            fileviewer::viewable_extensions,
            fileviewer::watch_file_for_viewer,
            fileviewer::unwatch_file_for_viewer,
            fileviewer::write_file_for_editor,
            fileviewer::list_directory,
            fileviewer::create_file,
            fileviewer::create_directory,
            fileviewer::rename_path,
            fileviewer::trash_entry,
            session::signal_frontend_ready,
            mac_window::title_bar_double_click_action,
            session::get_bootstrap_error,
            session::restart_daemon,
            daemon_compat,
            session::get_board,
            session::card_runs,
            session::set_board,
            session::get_orchestration,
            session::set_orchestration,
            session::set_rail_run,
            session::set_step_run,
            session::get_tools,
            session::save_tool,
            session::delete_tool,
            session::start_tool_run,
            session::set_tool_run_outcome,
            session::tool_runs,
            session::get_group_templates,
            session::save_group_template,
            session::delete_group_template,
            session::delete_board,
            session::watch_gavin_root,
            session::unwatch_gavin_root,
            session::get_gavin_tree,
            session::init_gavin_root,
            session::create_gavin_context,
            session::add_external_gavin_context,
            session::remove_external_gavin_context,
            session::gavin_root_exists,
            session::get_board_tabs,
            session::get_card_tabs,
            session::get_session_baselines,
            session::end_orphan,
            session::list_managed_sessions,
            session::queue_input,
            session::list_queued_inputs,
            session::set_queued_inputs,
            session::send_queued_input,
            session::set_board_tabs,
            session::set_card_tabs,
            session::set_plan_frontmatter_field,
            session::create_plan,
            session::set_checklist_item,
            session::delete_card_file,
            session::archive_card,
            session::unarchive_card,
            session::link_card_session,
            session::unlink_card_session,
            session::promote_checklist_item,
            session::set_root_config_field,
            session::get_agent_model_defaults,
            session::set_agent_model_default,
            session::get_superpowers_marks,
            session::set_superpowers_mark,
            superpowers::superpowers_status,
            superpowers::superpowers_install,
            agent_setup::setup_agent_integration,
            agent_setup::agent_profiles,
            agent_models::agent_model_catalog,
            agent_usage::agent_usage,
            pull_request::pr_status,
            agent_tokens::card_run_tokens,
            session::get_agent_pause,
            session::set_agent_pause,
            session::get_agent_defaults,
            session::set_agent_defaults,
            agent_setup::mcp_formats,
            agent_setup::move_agent_file,
            agent_setup::compose_agent_prompt,
            workspace_window::open_workspace_window,
            workspace_window::workspace_windows,
            workspace_window::claim_workspace_window,
            workspace_window::focus_workspace_window,
            workspace_window::close_workspace_window,
            workspace_delete::scan_gavin_footprint,
            workspace_delete::remove_gavin_footprint,
            git::git_repo_info,
            git::git_status,
            git::get_git_baselines,
            git::git_diff,
            git::git_head_sha,
            git::git_run_changes,
            git::git_diff_since,
            git::git_discard_run,
            git::git_stage_files,
            git::git_unstage_files,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_apply_patch,
            git::git_discard_files,
            git::git_commit,
            git::git_init,
            git::git_watch,
            git::git_unwatch,
            git::git_refs,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_cancel_op,
            git::git_checkout,
            git::git_create_branch,
            git::git_delete_branch,
            git::git_merged_branches,
            git::git_merge,
            git::git_abort_in_progress,
            git::git_continue_rebase,
            git::git_add_remote,
            git::git_remove_remote,
            git::git_stash_push,
            git::git_stash_pop,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_stash_files,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_worktree_prune,
            git::git_log,
            git::git_commit_detail,
            git::git_checkout_commit,
            git::git_cherry_pick,
            git::git_revert,
            git::git_reset,
            git::git_continue_in_progress,
            git::git_conflict,
            git::git_mark_resolved,
            git::git_resolve_whole,
            git::git_resolve_deleted,
            git::git_restore_conflict,
            git::git_merge_tool_name,
            worktree_setup::worktree_setup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
