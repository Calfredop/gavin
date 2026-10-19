//! Host backstop for top-level webview navigation.
//!
//! Repository markdown can still emit an `<a href>` after sanitizing.
//! The frontend intercepts clicks, but a missed handler (or anything
//! else that triggers navigation) must not replace the undecorated
//! gavin window with an attacker page. A plugin's `on_navigation`
//! covers every webview, including the config-built main window.

use url::Url;

/// Origins the app itself loads. Anything else is refused.
pub fn navigation_allowed(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        // tauri.conf.json build.devUrl — only the debug binary loads it.
        #[cfg(debug_assertions)]
        ("http", Some("localhost")) if url.port() == Some(1420) => true,
        _ => false,
    }
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_webview, url| navigation_allowed(url))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allows_app_origins() {
        assert!(navigation_allowed(&parse("tauri://localhost/index.html")));
        assert!(navigation_allowed(&parse("http://tauri.localhost/")));
        assert!(navigation_allowed(&parse("https://tauri.localhost/")));
    }

    #[test]
    fn refuses_foreign_origins() {
        assert!(!navigation_allowed(&parse("https://example.invalid/")));
        assert!(!navigation_allowed(&parse("http://attacker.example/guide")));
        assert!(!navigation_allowed(&parse("file:///etc/passwd")));
    }

    #[test]
    fn dev_url_only_in_debug() {
        let dev = parse("http://localhost:1420/");
        #[cfg(debug_assertions)]
        assert!(navigation_allowed(&dev));
        #[cfg(not(debug_assertions))]
        assert!(!navigation_allowed(&dev));
    }
}
