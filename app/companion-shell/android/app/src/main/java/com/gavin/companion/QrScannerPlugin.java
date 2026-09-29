package com.gavin.companion;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * The camera, for one thing: reading the pairing QR the desk shows
 * ({@code src/shell/native/qrScanner.ts}).
 *
 * <p>Registered on the shell's own Capacitor webview only. It is Google's
 * code scanner: Google Play services runs the camera in a screen of its own
 * and hands back only the code, so the app asks for no camera permission
 * and never sees a frame. The scanner's module is fetched when the app is
 * installed (the {@code barcode_ui} dependency in the manifest).
 *
 * <p>A debug build launched with {@code --es gavinPairCode <base64>}
 * (scripts/pair.sh) answers {@link #scriptedCode} with that code instead.
 */
@CapacitorPlugin(name = "QrScanner")
public class QrScannerPlugin extends Plugin {
    /** Set by {@link MainActivity} in a debug build: the code a script handed in, base64. */
    static volatile String scripted = null;

    @PluginMethod
    public void scan(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
        scanner.startScan()
            .addOnSuccessListener(barcode -> {
                String text = barcode.getRawValue();
                if (text == null) {
                    call.reject("the code held no text", "failed");
                    return;
                }
                JSObject answer = new JSObject();
                answer.put("text", text);
                call.resolve(answer);
            })
            .addOnCanceledListener(() -> call.reject("the scanner was closed", "cancelled"))
            .addOnFailureListener(e -> call.reject("the code could not be scanned: " + e.getMessage(), "failed"));
    }

    @PluginMethod
    public void scriptedCode(PluginCall call) {
        JSObject answer = new JSObject();
        String encoded = scripted;
        if (encoded == null) {
            answer.put("text", JSONObject.NULL);
        } else {
            try {
                answer.put("text", new String(Base64.decode(encoded, Base64.DEFAULT), StandardCharsets.UTF_8));
            } catch (IllegalArgumentException e) {
                answer.put("text", JSONObject.NULL);
            }
        }
        call.resolve(answer);
    }
}
