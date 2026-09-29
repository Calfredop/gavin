package com.gavin.companion;

import android.os.Handler;
import android.os.Looper;

/**
 * Whether the Companion is in front, as the Unlock needs to know it
 * (ADR 0004; {@code docs/research/2026-09-28-companion-device-keys.md}).
 *
 * <p>The app is in front while any of its activities is started: the
 * shell's {@link MainActivity}, or a bundle's {@link BundleActivity}. The
 * two live in different processes, so {@code ProcessLifecycleOwner} -- which
 * sees one process -- would take opening a Workstation's UI for going to
 * the background. This process hears of its own activity from the plugin,
 * and of the bundle's over the channel ({@link BundleChannel}).
 *
 * <p>Going to the background is decided a moment after the last activity
 * stops, as {@code ProcessLifecycleOwner} does: moving from one of the
 * app's activities to another stops the first before the second's news
 * has crossed from its process. Coming back to the front is decided at
 * once. Losing the focus -- the notification shade, a call banner, the
 * Unlock's own prompt -- stops nothing, and is not seen here at all.
 */
final class AppForeground {
    /** What the plugin hears: {@code foreground} or {@code background}. */
    interface Listener {
        void changed(String phase);
    }

    /** How long the app may have no started activity before it is in the background. */
    static final long SETTLE_MS = 700;

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static boolean shellStarted;
    private static boolean bundleShown;
    private static boolean inFront;
    private static Runnable pending;
    private static Listener listener;

    private AppForeground() {}

    static synchronized void listen(Listener next) {
        listener = next;
    }

    static synchronized boolean inFront() {
        return inFront;
    }

    /** The shell's own activity started or stopped. */
    static void shell(boolean started) {
        synchronized (AppForeground.class) {
            shellStarted = started;
        }
        update();
    }

    /** A bundle's activity is shown (opening, or started) or not (stopped, or closed). */
    static void bundle(boolean shown) {
        synchronized (AppForeground.class) {
            bundleShown = shown;
        }
        update();
    }

    private static void update() {
        Listener tell = null;
        synchronized (AppForeground.class) {
            if (shellStarted || bundleShown) {
                if (pending != null) {
                    main.removeCallbacks(pending);
                    pending = null;
                }
                if (!inFront) {
                    inFront = true;
                    tell = listener;
                }
            } else if (inFront && pending == null) {
                pending = AppForeground::settle;
                main.postDelayed(pending, SETTLE_MS);
            }
        }
        if (tell != null) tell.changed("foreground");
    }

    private static void settle() {
        Listener tell = null;
        synchronized (AppForeground.class) {
            pending = null;
            if (inFront && !shellStarted && !bundleShown) {
                inFront = false;
                tell = listener;
            }
        }
        if (tell != null) tell.changed("background");
    }
}
