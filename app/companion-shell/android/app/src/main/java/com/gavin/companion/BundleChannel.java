package com.gavin.companion;

import android.os.Bundle;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * The channel between the bundle's process and the shell's, as the shell's
 * process holds it.
 *
 * <p>The bundle's activity runs in a process of its own ({@code :bundle}):
 * WebView gives each app process one renderer, and the shell's webview
 * holds what a bundle must never reach (docs/research/2026-09-28-companion-
 * device-keys.md, section 4). So the channel crosses processes, as
 * {@link Message}s between the activity and {@link BundleChannelService}.
 * This is the service's side: which session is open, the activity's
 * {@link Messenger}, and the plugin that hands everything to the shell's
 * web layer.
 *
 * <p>A message crosses as one Binder transaction, so a single message is
 * bounded by Binder's buffer (about 1 MB). The Demo Workstation's messages
 * are far below that; a paired Workstation's large answers (a file, a long
 * diff) will need chunking when they arrive (companion-23).
 */
final class BundleChannel {
    static final String TAG = "GavinShell";

    // From the bundle's activity.
    static final int HELLO = 1;
    static final int FROM_BUNDLE = 2;
    static final int DROPPED = 3;
    static final int CLOSED = 4;
    static final int STARTED = 5;
    static final int STOPPED = 6;
    // To the bundle's activity.
    static final int TO_BUNDLE = 10;
    static final int CLOSE = 11;

    static final String SESSION = "session";
    static final String ORIGIN = "origin";
    static final String DATA = "data";
    static final String MAIN_FRAME = "mainFrame";

    /** What the shell's web layer hears. */
    interface Events {
        void message(int session, String origin, String data);

        void dropped(int session, String origin, boolean mainFrame);

        void closed(int session);
    }

    private static Events events;
    /** The open session, or 0. */
    private static int session;
    /** The open session's activity, once it has said hello. */
    private static Messenger bundle;
    /** What the shell said before the activity was there to hear it. */
    private static final List<String> early = new ArrayList<>();

    private BundleChannel() {}

    static synchronized void attach(Events sink) {
        events = sink;
    }

    /**
     * A new bundle view is opening; whatever was open is closed. The app
     * counts as in front through the opening: the shell's activity stops
     * before the bundle's has said it started.
     */
    static void opening(int next) {
        synchronized (BundleChannel.class) {
            if (session != 0) send(bundle, CLOSE, session, null);
            session = next;
            bundle = null;
            early.clear();
        }
        AppForeground.bundle(true);
    }

    /** The open session's activity started or stopped: Home, and back. */
    static void shown(int from, boolean started) {
        synchronized (BundleChannel.class) {
            if (from != session) return;
        }
        AppForeground.bundle(started);
    }

    static synchronized void hello(int from, Messenger activity) {
        if (from != session) {
            // A view the shell has already moved on from.
            send(activity, CLOSE, from, null);
            return;
        }
        bundle = activity;
        for (String data : early) send(bundle, TO_BUNDLE, session, data);
        early.clear();
    }

    static synchronized void toBundle(int to, String data) {
        if (to != session) return;
        if (bundle == null) early.add(data);
        else send(bundle, TO_BUNDLE, session, data);
    }

    static void close(int which) {
        synchronized (BundleChannel.class) {
            if (which != session) return;
            send(bundle, CLOSE, session, null);
            session = 0;
            bundle = null;
            early.clear();
        }
        AppForeground.bundle(false);
    }

    static void fromBundle(int from, String origin, String data) {
        Events sink;
        synchronized (BundleChannel.class) {
            if (from != session) return;
            sink = events;
        }
        if (sink != null) sink.message(from, origin, data);
    }

    static void dropped(int from, String origin, boolean mainFrame) {
        Events sink;
        synchronized (BundleChannel.class) {
            if (from != session) return;
            sink = events;
        }
        if (sink != null) sink.dropped(from, origin, mainFrame);
    }

    /** The view went away without the shell asking: the system's back gesture. */
    static void closed(int from) {
        Events sink;
        synchronized (BundleChannel.class) {
            if (from != session) return;
            session = 0;
            bundle = null;
            early.clear();
            sink = events;
        }
        AppForeground.bundle(false);
        if (sink != null) sink.closed(from);
    }

    private static void send(Messenger to, int what, int which, String data) {
        if (to == null) return;
        Message message = Message.obtain(null, what);
        Bundle payload = new Bundle();
        payload.putInt(SESSION, which);
        if (data != null) payload.putString(DATA, data);
        message.setData(payload);
        try {
            to.send(message);
        } catch (RemoteException | RuntimeException e) {
            // The bundle's process is gone, or the message is too large to
            // cross; either way it did not arrive.
            Log.w(TAG, "could not reach the bundle view: " + e);
        }
    }
}
