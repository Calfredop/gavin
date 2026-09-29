package com.gavin.companion;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * The shell's own Capacitor view: the Workstations hub, which ships in the
 * binary. It is the only webview with a Capacitor bridge, and the shell's
 * two plugins -- the bundle view and the Device's keys -- are registered on
 * it alone. A Workstation's bundle opens in {@link BundleActivity}, in a
 * process of its own.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BundleViewPlugin.class);
        registerPlugin(DeviceKeysPlugin.class);
        // `adb shell am start … --ez gavinBundleProbe true` (scripts/probe.sh),
        // `--ez gavinKeysCheck true` and `--ez gavinStrictKeys true` (scripts/keys.sh).
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        BundleViewPlugin.probeRequested = debuggable && getIntent().getBooleanExtra("gavinBundleProbe", false);
        DeviceKeysPlugin.checkRequested = debuggable && getIntent().getBooleanExtra("gavinKeysCheck", false);
        DeviceKeysPlugin.strict = debuggable && getIntent().getBooleanExtra("gavinStrictKeys", false);
        super.onCreate(savedInstanceState);
    }
}
