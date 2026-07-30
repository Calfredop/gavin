mod config;
mod daemon;
mod session;

use tauri::{Emitter, Manager};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(session::FrontendReady(std::sync::atomic::AtomicBool::new(false)));

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = session::bootstrap(handle.clone()) {
                    let _ = handle.emit("daemon-error", e.to_string());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            session::write_input,
            session::resize_session,
            session::get_current_session,
            session::signal_frontend_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
