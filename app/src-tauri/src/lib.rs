mod config;
mod daemon;
mod layout;
mod mac_window;
mod session;

use tauri::{Emitter, Manager};

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
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                mac_window::round_window_corners(&window, 10.0);
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
            session::get_workspaces_state,
            session::set_workspaces_state,
            session::get_session_names,
            session::set_session_name,
            session::signal_frontend_ready,
            session::get_bootstrap_error,
            session::get_board,
            session::set_board,
            session::delete_board
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
