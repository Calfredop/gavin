package com.gavin.companion;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The Workstations this Device has paired with ({@code src/shell/native/workstations.ts}).
 *
 * <p>Registered on the shell's own Capacitor webview only. The records --
 * the web layer's JSON, opaque here, keyed by Workstation id -- are one
 * file in {@code noBackupFilesDir}, sealed by a Keystore AES-GCM key, with
 * backup and device transfer off in the manifest. A record holds that
 * Workstation's notification key, which is why it lives here and not in
 * the webview's storage. The sealing key does not require the phone to be
 * unlocked, so that a push can be opened on a locked phone once
 * notifications exist -- the iOS side's "after first unlock".
 *
 * <p>The records go with the Device's keys ({@link DeviceKeysPlugin}): each
 * names the Device a Workstation paired, and a phone without those keys is
 * no longer that Device.
 */
@CapacitorPlugin(name = "Workstations")
public class WorkstationsPlugin extends Plugin {
    static final String WRAP_ALIAS = "com.gavin.companion.workstations-wrap";
    static final String FILE = "workstations";
    private static final int GCM_IV_BYTES = 12;
    /** Every read and write of the file, one at a time. */
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void list(PluginCall call) {
        worker.execute(() -> {
            try {
                JSONObject records = read(getContext());
                JSArray list = new JSArray();
                for (Iterator<String> ids = records.keys(); ids.hasNext(); ) list.put(records.getString(ids.next()));
                JSObject answer = new JSObject();
                answer.put("records", list);
                call.resolve(answer);
            } catch (Exception e) {
                call.reject("the paired Workstations could not be read: " + e, "failed");
            }
        });
    }

    @PluginMethod
    public void save(PluginCall call) {
        String id = call.getString("id");
        String record = call.getString("record");
        if (id == null || id.isEmpty() || record == null) {
            call.reject("save needs an id and a record", "failed");
            return;
        }
        worker.execute(() -> {
            try {
                JSONObject records = read(getContext());
                records.put(id, record);
                write(getContext(), records);
                call.resolve();
            } catch (Exception e) {
                call.reject("the Workstation could not be kept: " + e, "failed");
            }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("remove needs an id", "failed");
            return;
        }
        worker.execute(() -> {
            try {
                JSONObject records = read(getContext());
                records.remove(id);
                write(getContext(), records);
                call.resolve();
            } catch (Exception e) {
                call.reject("the Workstation could not be removed: " + e, "failed");
            }
        });
    }

    /** The records and their key, gone: what deleting the Device's keys takes with it. */
    static void deleteAll(Context context) {
        worker.execute(() -> {
            try {
                KeyStore keyStore = keyStore();
                if (keyStore.containsAlias(WRAP_ALIAS)) keyStore.deleteEntry(WRAP_ALIAS);
            } catch (Exception e) {
                Log.w(BundleChannel.TAG, "Workstations: could not delete the sealing key: " + e);
            }
            file(context).delete();
        });
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        return keyStore;
    }

    private static File file(Context context) {
        return new File(context.getNoBackupFilesDir(), FILE);
    }

    private static JSONObject read(Context context) throws Exception {
        File file = file(context);
        KeyStore keyStore = keyStore();
        if (!file.isFile() || !keyStore.containsAlias(WRAP_ALIAS)) return new JSONObject();
        byte[] blob = Files.readAllBytes(file.toPath());
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, (SecretKey) keyStore.getKey(WRAP_ALIAS, null),
            new GCMParameterSpec(128, blob, 0, GCM_IV_BYTES));
        byte[] plain = cipher.doFinal(blob, GCM_IV_BYTES, blob.length - GCM_IV_BYTES);
        return new JSONObject(new String(plain, StandardCharsets.UTF_8));
    }

    private static void write(Context context, JSONObject records) throws Exception {
        KeyStore keyStore = keyStore();
        SecretKey wrap;
        if (keyStore.containsAlias(WRAP_ALIAS)) {
            wrap = (SecretKey) keyStore.getKey(WRAP_ALIAS, null);
        } else {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(WRAP_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
            wrap = generator.generateKey();
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrap);
        byte[] sealed = cipher.doFinal(records.toString().getBytes(StandardCharsets.UTF_8));
        File target = file(context);
        File partial = new File(target.getPath() + ".partial");
        try (FileOutputStream out = new FileOutputStream(partial)) {
            out.write(cipher.getIV());
            out.write(sealed);
            out.getFD().sync();
        }
        Files.move(partial.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }
}
