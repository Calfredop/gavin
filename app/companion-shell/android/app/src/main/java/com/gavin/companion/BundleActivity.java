package com.gavin.companion;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * A Workstation's UI bundle, full-screen over the hub (ADR 0005, "Store
 * compliance").
 *
 * <p>It runs in its own app process ({@code :bundle}, see the manifest), so
 * its WebView renderer is not the shell's. The WebView is a plain one: no
 * Capacitor bridge, no {@code addJavascriptInterface}. Its one outlet is
 * {@code gavinChannel}, which {@code addWebMessageListener} injects only
 * into frames of the bundle's own origin; this activity then accepts only
 * the main frame, and carries what it says to the shell's process through
 * {@link BundleChannelService}. Anything else is dropped and reported by
 * origin alone.
 *
 * <p>Pages come from {@code https://<workstation>.bundle.gavin.invalid},
 * answered from the app's assets by {@link BundleFiles}; every other
 * request is refused and every other navigation blocked. A tapped web link
 * opens in the system browser.
 */
public class BundleActivity extends AppCompatActivity {
    static final String EXTRA_SESSION = "session";
    static final String EXTRA_WORKSTATION = "workstation";

    /** WebView keeps its data per process, and this process needs its own. */
    private static boolean suffixed = false;

    private int session;
    private BundleFiles files;
    private String origin;
    private WebView webView;
    private View top;
    private View bottom;
    /** The bundle's main frame, once it has spoken. */
    private JavaScriptReplyProxy reply;

    private Messenger shell;
    /** What the page said before the shell's process was bound. */
    private final List<Message> early = new ArrayList<>();
    private boolean closedByShell = false;

    private final Messenger incoming = new Messenger(new Handler(Looper.getMainLooper()) {
        @Override
        public void handleMessage(@NonNull Message message) {
            if (message.getData().getInt(BundleChannel.SESSION) != session) return;
            switch (message.what) {
                case BundleChannel.TO_BUNDLE:
                    if (reply != null) reply.postMessage(message.getData().getString(BundleChannel.DATA, ""));
                    break;
                case BundleChannel.CLOSE:
                    closedByShell = true;
                    finish();
                    break;
                default:
                    super.handleMessage(message);
            }
        }
    });

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            shell = new Messenger(binder);
            Message hello = message(BundleChannel.HELLO);
            hello.replyTo = incoming;
            send(hello);
            for (Message m : early) send(m);
            early.clear();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            // The shell's process died, and with it the other end.
            shell = null;
            finish();
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (!suffixed) {
            // Before any WebView in this process (measured in the spike).
            WebView.setDataDirectorySuffix("bundle");
            suffixed = true;
        }
        super.onCreate(savedInstanceState);
        session = getIntent().getIntExtra(EXTRA_SESSION, 0);
        String workstation = getIntent().getStringExtra(EXTRA_WORKSTATION);
        if (session <= 0 || !BundleFiles.carries(getAssets(), workstation)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Never a fallback to addJavascriptInterface: without an
            // origin-gated listener there is no channel, so there is no view.
            Log.w(BundleChannel.TAG, "cannot open the bundle for " + workstation);
            finish();
            return;
        }
        files = new BundleFiles(getAssets(), workstation);
        origin = BundleFiles.origin(workstation);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        webView = new WebView(this);
        top = new View(this);
        bottom = new View(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.addView(top, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(bottom, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));
        // The page draws between the system bars, not under them: Android's
        // WebView does not tell a page where they are.
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, 0, bars.right, 0);
            top.getLayoutParams().height = bars.top;
            bottom.getLayoutParams().height = bars.bottom;
            top.requestLayout();
            bottom.requestLayout();
            return WindowInsetsCompat.CONSUMED;
        });
        setContentView(root);
        paint();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        // With multiple windows on, `window.open` asks onCreateWindow, which
        // refuses; off, it would load the link in this view instead.
        settings.setSupportMultipleWindows(true);
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (files.isOwn(url)) return files.serve(url);
                if ("about".equals(url.getScheme()) || "data".equals(url.getScheme()) || "blob".equals(url.getScheme())) {
                    return null;
                }
                Log.i(BundleChannel.TAG, "bundle: refused a request for " + url);
                return BundleFiles.refused();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (files.isOwn(url)) return false;
                boolean web = "https".equals(url.getScheme()) || "http".equals(url.getScheme());
                if (web && request.hasGesture()) {
                    openInBrowser(url);
                } else {
                    Log.i(BundleChannel.TAG, "bundle: blocked a navigation to " + url);
                }
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The renderer is this process's alone; losing it ends the
                // visit rather than the app.
                finish();
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message resultMsg) {
                return false;
            }
        });

        WebViewCompat.addWebMessageListener(webView, "gavinChannel", Collections.singleton(origin),
            (view, message, sourceOrigin, isMainFrame, replyProxy) -> receive(message, sourceOrigin, isMainFrame, replyProxy));

        bindService(new Intent(this, BundleChannelService.class), connection, BIND_AUTO_CREATE | BIND_IMPORTANT);
        webView.loadUrl(origin + "/");
    }

    private void receive(WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
        String from = sourceOrigin == null ? "null" : sourceOrigin.toString();
        String data = message.getType() == WebMessageCompat.TYPE_STRING ? message.getData() : null;
        if (!isMainFrame || !origin.equals(from) || data == null) {
            Log.i(BundleChannel.TAG, "bundle: dropped a channel message from " + from + " (main frame: " + isMainFrame + ")");
            Message dropped = message(BundleChannel.DROPPED);
            dropped.getData().putString(BundleChannel.ORIGIN, from);
            dropped.getData().putBoolean(BundleChannel.MAIN_FRAME, isMainFrame);
            send(dropped);
            return;
        }
        // The main frame's latest: a reload gives the page a new one.
        reply = replyProxy;
        Message said = message(BundleChannel.FROM_BUNDLE);
        said.getData().putString(BundleChannel.ORIGIN, from);
        said.getData().putString(BundleChannel.DATA, data);
        send(said);
    }

    private Message message(int what) {
        Message m = Message.obtain(null, what);
        Bundle payload = new Bundle();
        payload.putInt(BundleChannel.SESSION, session);
        m.setData(payload);
        return m;
    }

    private void send(Message m) {
        if (shell == null) {
            early.add(m);
            return;
        }
        try {
            shell.send(m);
        } catch (RemoteException | RuntimeException e) {
            Log.w(BundleChannel.TAG, "could not reach the shell: " + e);
        }
    }

    private void openInBrowser(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Log.w(BundleChannel.TAG, "nothing opens " + url);
        }
    }

    /** The desktop theme's colours around the page: its header's above, its base below. */
    private void paint() {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            != Configuration.UI_MODE_NIGHT_NO;
        int sunken = dark ? Color.rgb(0x1a, 0x1a, 0x1a) : Color.rgb(0xee, 0xee, 0xee);
        int base = dark ? Color.rgb(0x1e, 0x1e, 0x1e) : Color.WHITE;
        top.setBackgroundColor(sunken);
        bottom.setBackgroundColor(base);
        webView.setBackgroundColor(base);
        getWindow().getDecorView().setBackgroundColor(base);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(!dark);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(!dark);
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (webView != null) paint();
    }

    /** Tells the shell's process, which decides whether the app is in front ({@link AppForeground}). */
    @Override
    protected void onStart() {
        super.onStart();
        send(message(BundleChannel.STARTED));
    }

    @Override
    protected void onStop() {
        send(message(BundleChannel.STOPPED));
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            if (isFinishing() && !closedByShell) send(message(BundleChannel.CLOSED));
            try {
                unbindService(connection);
            } catch (IllegalArgumentException ignored) {
                // Never bound.
            }
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
