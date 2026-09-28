//! Keep-running mode: the app stays up with its window closed while
//! remote access is on (ADR 0003, companion spec "The desktop app").
//!
//! The Companion drives the running desktop app, not the daemon. The rail
//! scheduler and card launching live in the webview, so a closed window
//! has to leave that webview RUNNING: closing the main window HIDES it and
//! puts an icon in the menu bar to bring it back or quit. Destroying it
//! would take the scheduler with it. A hidden window is still in the
//! host's window list, so the duty (`workspace_window.rs`) and each
//! workspace's rails stay exactly where they were.
//!
//! The decision itself -- hide, or ask as before -- is the frontend's
//! (`keepRunning.ts`), because the close request already goes through its
//! `onCloseRequested` handler; this module only carries it out. The same
//! goes for the idle-sleep hold: the window holding the app's duties
//! decides when it is wanted and says so here.
//!
//! What a hidden webview would otherwise lose, measured on the card
//! `companion-06-keep-running-mode.md`: WebKit halves a hidden page's
//! timers (`setInterval(1000)` fires every 2 s) and lets its process nap,
//! stalling them for seconds at a time -- 25 s in a bare WKWebView.
//! `keep_timers_on_time` turns that off for every app window.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::workspace_window::MAIN_WINDOW_LABEL;

const TRAY_ID: &str = "keep-running";
const MENU_OPEN: &str = "keep-running-open";
const MENU_QUIT: &str = "keep-running-quit";

/// Closes the calling window to the menu bar: the icon goes up FIRST, then
/// the window goes away, so there is never a moment with neither.
///
/// A plain `fn` on purpose. It runs on the main thread, where AppKit
/// wants both the status item and the window order-out, and tauri runs a
/// main-thread task inline when it is already there.
#[tauri::command]
pub fn hide_to_menu_bar(app_handle: AppHandle, window: tauri::Window) -> Result<(), String> {
    show_menu_bar_icon(&app_handle).map_err(|e| e.to_string())?;
    window.hide().map_err(|e| e.to_string())
}

fn show_menu_bar_icon(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Gavin", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Gavin", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(menu_bar_glyph())
        // A template image: macOS tints it for a light or dark menu bar,
        // and dims it with every other icon when the bar is inactive.
        .icon_as_template(true)
        .tooltip("Gavin is running for remote access")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => reopen_main_window(app),
            // The app, not the daemon: sessions keep running, as they do
            // after the close prompt's first two rungs (appClose.ts).
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Brings the main window back and takes the icon down: once the window
/// is on screen, the window is the handle.
pub fn reopen_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    let _ = app.remove_tray_by_id(TRAY_ID);
}

// ---- The menu-bar glyph -----------------------------------------------------

/// The app icon's ">G", cell for cell: `icons/icon.svg` draws both glyphs
/// on a 32 px grid, and these are its rects divided by 32 and moved to the
/// chevron's top-left corner. (col, row, width, height), in cells.
const GLYPH_CELLS: &[(u32, u32, u32, u32)] = &[
    // ">"
    (0, 0, 2, 1),
    (1, 1, 2, 1),
    (2, 2, 2, 2),
    (3, 4, 2, 1),
    (4, 5, 2, 2),
    (3, 7, 2, 1),
    (2, 8, 2, 2),
    (1, 10, 2, 1),
    (0, 11, 2, 1),
    // "G"
    (11, 0, 6, 1),
    (10, 1, 1, 1),
    (17, 1, 1, 1),
    (18, 2, 1, 1),
    (9, 2, 1, 8),
    (15, 6, 4, 1),
    (18, 7, 1, 3),
    (10, 10, 1, 1),
    (17, 10, 1, 1),
    (11, 11, 6, 1),
];
const GLYPH_COLS: u32 = 19;
const GLYPH_ROWS: u32 = 12;
/// Pixels per cell. The status item is drawn 18 pt tall, and the image
/// is 36 px tall for a Retina bar, so 2 px is one point: every stroke of
/// the G lands on whole points and stays crisp.
const CELL_PX: u32 = 2;
/// Space around the glyph, in pixels. The bar scales the whole image to
/// its height, so the vertical pad is what keeps the glyph 12 pt tall
/// rather than filling the bar edge to edge.
const PAD_X: u32 = 2;
const PAD_Y: u32 = 6;

fn menu_bar_glyph() -> Image<'static> {
    let width = GLYPH_COLS * CELL_PX + 2 * PAD_X;
    let height = GLYPH_ROWS * CELL_PX + 2 * PAD_Y;
    let mut rgba = vec![0u8; (width * height * 4) as usize];
    for &(col, row, w, h) in GLYPH_CELLS {
        for y in PAD_Y + row * CELL_PX..PAD_Y + (row + h) * CELL_PX {
            for x in PAD_X + col * CELL_PX..PAD_X + (col + w) * CELL_PX {
                let i = ((y * width + x) * 4) as usize;
                // Black, opaque: a template image is read for its alpha.
                rgba[i + 3] = 0xff;
            }
        }
    }
    Image::new_owned(rgba, width, height)
}

// ---- Timers in a hidden window ----------------------------------------------

/// Keeps a webview's timers on time while its window is hidden, minimized
/// or on another Space.
///
/// WebKit throttles a page it cannot see: DOM timers are aligned to a
/// coarser clock, and the web content process is let go into App Nap,
/// where it stops altogether for seconds at a time. For a browser tab that
/// is the right call. Here the page is the rail scheduler, the launch
/// queue and every poll the scheduler rides on, and a hidden window is
/// exactly the state keep-running mode puts it in.
///
/// It takes BOTH halves, measured in this app with the window closed to
/// the menu bar and nothing running (companion-06's card has the runs):
/// with either one alone a `setInterval(1000)` still fired every 2 s, or
/// stalled for up to 7 s; with both, every gap was 1004-1006 ms for four
/// minutes. The public half is `inactiveSchedulingPolicy` (macOS 14+).
/// The other half is WKPreferences SPI -- there is no public switch for
/// DOM timer throttling or visibility-based process suppression -- so
/// every setter is sent only when WebKit answers to it. A WebKit without
/// one keeps that throttling, and nothing breaks.
///
/// Set once, as the window is built: re-applying at page load and again
/// at hide measured no different.
#[cfg(target_os = "macos")]
pub fn keep_timers_on_time(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::{msg_send, sel};

        /// `WKInactiveSchedulingPolicyNone`.
        const INACTIVE_SCHEDULING_NONE: isize = 2;

        let view = webview.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        // SAFETY: `inner()` is the live WKWebView tauri holds for this
        // window, and `with_webview` runs this on the main thread while
        // tauri keeps it retained. `configuration` and `preferences` are
        // public WKWebView/WKWebViewConfiguration getters; the preferences
        // object is the one the page reads, shared rather than copied, so
        // a change to it reaches the page already created.
        let prefs: Option<Retained<AnyObject>> = unsafe {
            let view = &*view;
            let config: Option<Retained<AnyObject>> = msg_send![view, configuration];
            match config {
                Some(config) => msg_send![&config, preferences],
                None => None,
            }
        };
        let Some(prefs) = prefs else {
            return;
        };
        // SAFETY: `respondsToSelector:` is NSObject's, and every setter
        // below is sent only after it has said this WebKit has it. The
        // policy setter takes an NSInteger; the other three one BOOL each;
        // all return void.
        unsafe {
            let answers = |selector| -> bool { msg_send![&prefs, respondsToSelector: selector] };
            if answers(sel!(setInactiveSchedulingPolicy:)) {
                let _: () = msg_send![&prefs, setInactiveSchedulingPolicy: INACTIVE_SCHEDULING_NONE];
            }
            if answers(sel!(_setHiddenPageDOMTimerThrottlingEnabled:)) {
                let _: () = msg_send![&prefs, _setHiddenPageDOMTimerThrottlingEnabled: false];
            }
            if answers(sel!(_setHiddenPageDOMTimerThrottlingAutoIncreases:)) {
                let _: () = msg_send![&prefs, _setHiddenPageDOMTimerThrottlingAutoIncreases: false];
            }
            if answers(sel!(_setPageVisibilityBasedProcessSuppressionEnabled:)) {
                let _: () = msg_send![&prefs, _setPageVisibilityBasedProcessSuppressionEnabled: false];
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn keep_timers_on_time(_window: &tauri::WebviewWindow) {}

// ---- The idle-sleep hold ----------------------------------------------------

/// The live hold, if one is taken. At most one: the command is a level,
/// not a counter, so a window that says "hold" twice holds once.
#[derive(Default)]
pub struct SleepHold(std::sync::Mutex<Option<sleep::Activity>>);

/// Holds off idle system sleep, or lets it go. The window holding the
/// app's duties sends this whenever its answer changes (keepRunning.ts:
/// remote access on AND an agent running).
///
/// Idle sleep only: the display still sleeps, and a closed lid or a Sleep
/// from the Apple menu still sleeps the Mac. The hold dies with the
/// process, so an app that quits or crashes never leaves the Mac awake.
#[tauri::command]
pub fn set_sleep_hold(hold: bool, state: tauri::State<SleepHold>) {
    apply_hold(&mut state.0.lock().unwrap(), hold);
}

fn apply_hold(slot: &mut Option<sleep::Activity>, hold: bool) {
    if hold && slot.is_none() {
        *slot = sleep::begin();
    } else if !hold {
        if let Some(activity) = slot.take() {
            sleep::end(activity);
        }
    }
}

#[cfg(target_os = "macos")]
mod sleep {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{ns_string, NSActivityOptions, NSProcessInfo};

    /// An NSProcessInfo activity token. It is what `pmset -g assertions`
    /// lists as a PreventUserIdleSystemSleep held by Gavin, with the
    /// reason below -- which is how a human finds out why their Mac
    /// stayed up.
    pub struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    // SAFETY: the token is an opaque object that is only ever handed back
    // to `endActivity:`, and NSProcessInfo's activity API is documented
    // safe to call from any thread.
    unsafe impl Send for Activity {}

    pub fn begin() -> Option<Activity> {
        let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::IdleSystemSleepDisabled,
            ns_string!("Remote access is on and an agent is running"),
        );
        Some(Activity(token))
    }

    pub fn end(activity: Activity) {
        // SAFETY: the token came from `beginActivityWithOptions:reason:`
        // on this same NSProcessInfo, and is ended exactly once -- it is
        // moved in here.
        unsafe { NSProcessInfo::processInfo().endActivity(&activity.0) };
    }
}

/// Elsewhere there is no hold yet: the Companion's desk is a Mac first.
#[cfg(not(target_os = "macos"))]
mod sleep {
    pub struct Activity;

    pub fn begin() -> Option<Activity> {
        None
    }

    pub fn end(_activity: Activity) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha_at(image: &Image<'_>, x: u32, y: u32) -> u8 {
        image.rgba()[((y * image.width() + x) * 4 + 3) as usize]
    }

    /// A Retina status item is 36 px tall; anything else is rescaled by
    /// the bar and blurs the one-point strokes.
    #[test]
    fn the_glyph_is_drawn_for_a_retina_menu_bar() {
        let image = menu_bar_glyph();
        assert_eq!(image.height(), 36);
        assert_eq!(image.width(), 42);
    }

    /// Every cell sits inside the 19 x 12 grid the icon's glyphs span, so
    /// no rect is clipped at the canvas edge or lands in the padding.
    #[test]
    fn every_cell_is_inside_the_glyph_grid() {
        for &(col, row, w, h) in GLYPH_CELLS {
            assert!(col + w <= GLYPH_COLS, "cell at col {col} runs past the grid");
            assert!(row + h <= GLYPH_ROWS, "cell at row {row} runs past the grid");
        }
    }

    #[test]
    fn the_padding_stays_clear_and_the_strokes_are_opaque() {
        let image = menu_bar_glyph();
        for x in 0..image.width() {
            assert_eq!(alpha_at(&image, x, 0), 0);
            assert_eq!(alpha_at(&image, x, image.height() - 1), 0);
        }
        // The chevron's top-left cell and the G's left stem.
        assert_eq!(alpha_at(&image, PAD_X, PAD_Y), 0xff);
        assert_eq!(alpha_at(&image, PAD_X + 9 * CELL_PX, PAD_Y + 5 * CELL_PX), 0xff);
        // The G's counter is open.
        assert_eq!(alpha_at(&image, PAD_X + 13 * CELL_PX, PAD_Y + 5 * CELL_PX), 0);
    }

    /// Saying "hold" twice holds once, and one "release" lets it go --
    /// the duty window re-sends its answer whenever it starts, so a
    /// counter would leak a hold per handover.
    #[test]
    fn a_hold_is_a_level_not_a_counter() {
        let mut slot = None;
        let held = cfg!(target_os = "macos");
        apply_hold(&mut slot, true);
        assert_eq!(slot.is_some(), held);
        apply_hold(&mut slot, true);
        assert_eq!(slot.is_some(), held);
        apply_hold(&mut slot, false);
        assert!(slot.is_none());
        apply_hold(&mut slot, false);
        assert!(slot.is_none());
    }
}
