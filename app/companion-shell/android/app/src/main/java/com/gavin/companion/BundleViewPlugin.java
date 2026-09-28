package com.gavin.companion;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The shell's bundle webview, as its web layer drives it
 * ({@code src/shell/native/bundleView.ts}).
 *
 * <p>Registered on the shell's own Capacitor webview only. A bundle cannot
 * call it: its webview, in {@link BundleActivity}, has no bridge. What a
 * bundle says arrives here as a {@code message} event, after the activity
 * has checked where it came from, and the shell's answer goes back through
 * {@code post}.
 */
@CapacitorPlugin(name = "BundleView")
public class BundleViewPlugin extends Plugin implements BundleChannel.Events {
    /** Set by {@link MainActivity} when a debug build is launched to run the probe. */
    static volatile boolean probeRequested = false;

    @Override
    public void load() {
        BundleChannel.attach(this);
    }

    @PluginMethod
    public void open(PluginCall call) {
        Integer session = call.getInt("session");
        String workstation = call.getString("workstation");
        if (session == null || session <= 0 || workstation == null) {
            call.reject("open needs a session and a workstation");
            return;
        }
        if (!BundleFiles.carries(getContext().getAssets(), workstation)) {
            call.reject("this app carries no UI for “" + workstation + "”");
            return;
        }
        BundleChannel.opening(session);
        Intent intent = new Intent(getContext(), BundleActivity.class)
            .putExtra(BundleActivity.EXTRA_SESSION, (int) session)
            .putExtra(BundleActivity.EXTRA_WORKSTATION, workstation);
        getActivity().runOnUiThread(() -> {
            getActivity().startActivity(intent);
            // Answered once the activity is on its way, before its page
            // loads: the page's first message then follows the answer.
            JSObject answer = new JSObject();
            answer.put("origin", BundleFiles.origin(workstation));
            call.resolve(answer);
        });
    }

    @PluginMethod
    public void post(PluginCall call) {
        Integer session = call.getInt("session");
        String data = call.getString("data");
        if (session == null || data == null) {
            call.reject("post needs a session and data");
            return;
        }
        BundleChannel.toBundle(session, data);
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        Integer session = call.getInt("session");
        if (session == null) {
            call.reject("close needs a session");
            return;
        }
        BundleChannel.close(session);
        call.resolve();
    }

    /** Only a web link, and only to the system browser. */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String raw = call.getString("url");
        Uri url = raw == null ? null : Uri.parse(raw);
        if (url == null || !("https".equals(url.getScheme()) || "http".equals(url.getScheme()))) {
            call.reject("only a web link opens outside the app");
            return;
        }
        Log.i(BundleChannel.TAG, "opening " + raw + " in the system browser");
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("nothing on this phone opens " + raw);
        }
    }

    /** Never true in a release build. */
    @PluginMethod
    public void probeRequested(PluginCall call) {
        boolean debuggable = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        JSObject answer = new JSObject();
        answer.put("probe", debuggable && probeRequested);
        call.resolve(answer);
    }

    // BundleChannel.Events

    @Override
    public void message(int session, String origin, String data) {
        JSObject event = new JSObject();
        event.put("session", session);
        event.put("origin", origin);
        event.put("data", data);
        notifyListeners("message", event);
    }

    @Override
    public void dropped(int session, String origin, boolean mainFrame) {
        JSObject event = new JSObject();
        event.put("session", session);
        event.put("origin", origin);
        event.put("mainFrame", mainFrame);
        notifyListeners("dropped", event);
    }

    @Override
    public void closed(int session) {
        JSObject event = new JSObject();
        event.put("session", session);
        notifyListeners("closed", event);
    }
}
