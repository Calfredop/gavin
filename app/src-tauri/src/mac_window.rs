// macOS-only: `decorations: false` removes not just the native title bar
// but the window's native corner rounding and shadow-follows-shape
// behavior too -- CSS `border-radius` on the WebView content alone can't
// recreate this, since it only clips what's painted *inside* the WebView,
// not the underlying native window surface. This gets the raw NSWindow
// handle and rounds its actual CALayer directly, the same technique real
// macOS apps use.
//
// Uses `objc2`/`objc2-app-kit`/`objc2-quartz-core` (the modern,
// actively-maintained Objective-C interop crates -- Tauri's own docs now
// recommend this family over the older `cocoa`/`objc` crates). Every
// AppKit call here is a safe wrapper; the only `unsafe` in this file is
// the single raw-pointer-to-reference conversion for the NSWindow handle
// Tauri hands back, documented at its call site.

#[cfg(target_os = "macos")]
pub fn round_window_corners(window: &tauri::WebviewWindow, radius: f64) {
    use objc2_app_kit::{NSColor, NSWindow};

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window_ptr = ns_window_ptr as *mut NSWindow;
    if ns_window_ptr.is_null() {
        return;
    }
    // SAFETY: `window.ns_window()` returns an autoreleased pointer to the
    // real NSWindow, which is independently retained by the windowing
    // layer for the life of `window` -- autorelease only governs this
    // transient handle, not the underlying object. This function uses it
    // entirely synchronously, on the same thread, with no await points
    // that could let the autorelease pool drain mid-use, so the deref
    // below is sound. Everything past this line uses objc2's safe method
    // wrappers -- no further raw pointer/memory access happens here.
    let ns_window = unsafe { &*ns_window_ptr };

    ns_window.setOpaque(false);
    ns_window.setBackgroundColor(Some(&NSColor::clearColor()));

    let Some(content_view) = ns_window.contentView() else {
        return;
    };
    content_view.setWantsLayer(true);
    if let Some(layer) = content_view.layer() {
        layer.setCornerRadius(radius);
        layer.setMasksToBounds(true);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn round_window_corners(_window: &tauri::WebviewWindow, _radius: f64) {}
