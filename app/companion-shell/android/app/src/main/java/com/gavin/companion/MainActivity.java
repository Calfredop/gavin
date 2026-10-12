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
        // `adb shell am start … --ez gavinBundleProbe true` (scripts/probe.sh),
        // `--ez gavinKeysCheck true` and `--ez gavinStrictKeys true` (scripts/keys.sh),
        // `--es gavinPairCode <base64>` (scripts/pair.sh).
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        QrScannerPlugin.scripted = debuggable ? getIntent().getStringExtra("gavinPairCode") : null;
        BundleViewPlugin.probeRequested = debuggable && getIntent().getBooleanExtra("gavinBundleProbe", false);
        DeviceKeysPlugin.checkRequested = debuggable && getIntent().getBooleanExtra("gavinKeysCheck", false);
        DeviceKeysPlugin.strict = debuggable && getIntent().getBooleanExtra("gavinStrictKeys", false);
        super.onCreate(savedInstanceState);
        SystemTextSize.apply(bridge.getWebView(), getResources().getConfiguration());
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (bridge != null) SystemTextSize.apply(bridge.getWebView(), configuration);
    }
}
