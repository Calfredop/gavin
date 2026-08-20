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

/// The user's System Settings choice for "Double-click a window's title
/// bar to" -- the raw `AppleActionOnDoubleClick` global default
/// ("Maximize" = Zoom, "Minimize", "Fill", "None"). `None` when unset
/// (the OS default, Zoom) and always `None` off macOS; the frontend maps
/// it (`titleBarGesture.ts`), since the custom title bar is DOM and the
/// double-click is detected there.
#[tauri::command]
pub fn title_bar_double_click_action() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{ns_string, NSUserDefaults};
        NSUserDefaults::standardUserDefaults()
            .stringForKey(ns_string!("AppleActionOnDoubleClick"))
            .map(|s| s.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Native macOS lets you double-click a window edge to extend that edge
/// to the screen edge (Option: the opposite edge too). AppKit implements
/// that in the title-bar frame class, which a `decorations: false`
/// (borderless) window doesn't have -- borderless windows keep edge
/// *drag* resizing but lose the double-click. Those edge clicks never
/// reach the WebView either (AppKit's resize tracking eats them), so the
/// only place to see them is a local NSEvent monitor, which runs before
/// dispatch. We act on the second click of a double-click at an edge and
/// swallow it so it doesn't start a stray resize-drag; every other event
/// passes through untouched.
#[cfg(target_os = "macos")]
pub fn install_edge_double_click(window: &tauri::WebviewWindow, tolerance: f64) {
    use crate::edge_expand::{expanded_frame, hit_edges, Rect};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use std::ptr::NonNull;

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }
    // Identity only -- compared against the event's window pointer, never
    // dereferenced. The NSWindow outlives the monitor (app lifetime).
    let main_window = ns_window_ptr as usize;

    let handler = block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let pass_through = event.as_ptr();
        // Local monitors are invoked on the main thread; bail rather
        // than assume if that ever stops being true.
        let Some(mtm) = MainThreadMarker::new() else {
            return pass_through;
        };
        // SAFETY: AppKit hands the monitor a live NSEvent for the
        // duration of the call; we only read from it synchronously.
        let event = unsafe { event.as_ref() };
        if event.clickCount() != 2 {
            return pass_through;
        }
        let Some(win) = event.window(mtm) else {
            return pass_through;
        };
        if objc2::rc::Retained::as_ptr(&win) as usize != main_window {
            return pass_through;
        }
        let Some(screen) = win.screen() else {
            return pass_through;
        };

        let click = win.convertPointToScreen(event.locationInWindow());
        let frame = to_rect(win.frame());
        let edges = hit_edges(frame, (click.x, click.y), tolerance);
        let option = event.modifierFlags().contains(NSEventModifierFlags::Option);
        let Some(next) = expanded_frame(frame, to_rect(screen.visibleFrame()), edges, option) else {
            return pass_through;
        };

        win.setFrame_display(from_rect(next), true);
        // Handled: swallow the click so AppKit doesn't also begin a resize.
        std::ptr::null_mut()
    });

    // SAFETY: the block returns either the event pointer it was given or
    // null, both valid per the AppKit contract for local monitors.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::LeftMouseDown, &handler)
    };
    // The monitor must stay registered for the life of the app; AppKit
    // retains it, and we deliberately never remove it.
    std::mem::forget(monitor);

    fn to_rect(r: NSRect) -> Rect {
        Rect::new(r.origin.x, r.origin.y, r.size.width, r.size.height)
    }
    fn from_rect(r: Rect) -> NSRect {
        NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.w, r.h))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install_edge_double_click(_window: &tauri::WebviewWindow, _tolerance: f64) {}
