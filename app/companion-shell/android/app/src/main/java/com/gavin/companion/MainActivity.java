package com.gavin.companion;

import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.os.Bundle;

import androidx.annotation.NonNull;

import com.getcapacitor.BridgeActivity;

/**
 * The shell's own Capacitor view: the Workstations hub, which ships in the
 * binary. It is the only webview with a Capacitor bridge, and the shell's
 * plugins -- the bundle view, the Device's keys, the camera and the paired
 * Workstations -- are registered on it alone. A Workstation's bundle opens in {@link BundleActivity}, in a
 * process of its own.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BundleViewPlugin.class);
        registerPlugin(DeviceKeysPlugin.class);
        registerPlugin(QrScannerPlugin.class);
        registerPlugin(WorkstationsPlugin.class);
        // Script-only debug triggers: files under files/gavin-debug/ written
        // by `adb shell run-as` (scripts/keys.sh, pair.sh, probe.sh, hub.sh).
        // Intent extras are ignored — any app can start this exported activity.
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        DebugLaunch debug = DebugLaunch.consume(getFilesDir(), debuggable);
        QrScannerPlugin.scripted = debug.pairCode;
        BundleViewPlugin.probeRequested = debug.bundleProbe;
        DeviceKeysPlugin.checkRequested = debug.keysCheck;
        DeviceKeysPlugin.strict = debug.strictKeys;
        super.onCreate(savedInstanceState);
        SystemTextSize.apply(bridge.getWebView(), getResources().getConfiguration());
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (bridge != null) SystemTextSize.apply(bridge.getWebView(), configuration);
    }
}
