package com.gavin.companion;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * The shell's own Capacitor view: the Workstations hub, which ships in the
 * binary. It is the only webview with a Capacitor bridge. A Workstation's
 * bundle opens in {@link BundleActivity}, in a process of its own.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BundleViewPlugin.class);
        // `adb shell am start … --ez gavinBundleProbe true` (scripts/probe.sh).
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        BundleViewPlugin.probeRequested = debuggable && getIntent().getBooleanExtra("gavinBundleProbe", false);
        super.onCreate(savedInstanceState);
    }
}
