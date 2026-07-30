mod config;
mod daemon;
mod layout;
mod session;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(session::FrontendReady(std::sync::atomic::AtomicBool::new(false)))
        .manage(session::BootstrapError(std::sync::Mutex::new(None)))
        .setup(|app| {
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
            session::get_current_layout,
            session::set_layout,
            session::signal_frontend_ready,
            session::get_bootstrap_error
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
