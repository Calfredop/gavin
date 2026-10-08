package com.gavin.companion;

import android.content.res.Configuration;
import android.webkit.WebView;

/**
 * The text size the person set in Android's settings, carried into a
 * WebView: the hub's and a bundle's.
 *
 * <p>The pages size their type against the root, which on iOS follows the
 * system text size through a probe in iOS's body style
 * ({@code $companion/surfaces/textScale.ts}). Android has no such style, so
 * the scale is the WebView's text zoom, set from the configuration's font
 * scale here, and again whenever it changes: both activities take a
 * {@code fontScale} change themselves (the manifest's
 * {@code configChanges}), so the page follows without being reloaded.
 */
final class SystemTextSize {
    private SystemTextSize() {}

    static void apply(WebView webView, Configuration configuration) {
        if (webView == null) return;
        webView.getSettings().setTextZoom(Math.round(configuration.fontScale * 100));
    }
}
