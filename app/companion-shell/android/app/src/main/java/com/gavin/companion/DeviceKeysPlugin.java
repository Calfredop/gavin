package com.gavin.companion;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;
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
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The Device's two keys (ADR 0001), as the shell's web layer drives them
 * ({@code src/shell/native/deviceKeys.ts}).
 *
 * <p>Registered on the shell's own Capacitor webview only, in the shell's
 * process. A bundle cannot call it: its webview, in {@link BundleActivity}
 * and a process of its own, has no bridge.
 *
 * <ul>
 *   <li><b>The hardware key</b> is a Keystore P-256 key in StrongBox, or
 *   else the TEE. It signs only within {@link #AUTH_WINDOW_SECONDS} of the
 *   owner authenticating -- a strong biometric or the device credential --
 *   and never while the phone is locked, and it is gone for good if the
 *   lock screen is removed. It signs one kind of message:
 *   {@link #UNLOCK_CONTEXT} followed by a 32-byte handshake hash, built
 *   here.
 *   <li><b>The Noise key</b> is 32 random bytes sealed by a Keystore
 *   AES-GCM key and kept in {@code noBackupFilesDir}, with backup and
 *   device transfer off in the manifest. It goes to the shell's web layer,
 *   where the Companion core does the Diffie-Hellman (ADR 0002).
 * </ul>
 *
 * <p>An emulator's Keystore is software. A debug build keeps such a key,
 * marked {@code software-debug}, which only a debug daemon accepts; any
 * other build refuses the phone ({@code docs/research/2026-09-28-companion-device-keys.md}).
 *
 * <p>Each sign asks for the owner. Keeping one authentication for a whole
 * foreground stretch is the Unlock's, and the Unlock is companion-22's.
 */
@CapacitorPlugin(name = "DeviceKeys")
public class DeviceKeysPlugin extends Plugin {
    /** What the hardware key signs ahead of the handshake hash: the wire's {@code device_wire::unlock_message}. */
    static final byte[] UNLOCK_CONTEXT = "gavin-device-unlock-v1".getBytes(StandardCharsets.US_ASCII);
    static final int HANDSHAKE_HASH_BYTES = 32;

    /**
     * How long after the owner authenticates the hardware key may sign.
     * One hour, as ticket 02 recommends; the owner's answer to its
     * decision replaces it. Any lock-screen unlock also opens this window,
     * which is why the shell asks for the owner itself before every sign.
     * Changing it changes only keys made afterwards.
     */
    static final int AUTH_WINDOW_SECONDS = 3600;

    static final String HARDWARE_ALIAS = "com.gavin.companion.device-key";
    static final String NOISE_WRAP_ALIAS = "com.gavin.companion.noise-wrap";
    static final String NOISE_FILE = "noise-key";
    private static final int GCM_IV_BYTES = 12;

    static final String NO_PASSCODE = "no-passcode";
    static final String NO_HARDWARE_KEYSTORE = "no-hardware-keystore";
    static final String KEYS_EXIST = "keys-exist";
    static final String NO_KEYS = "no-keys";
    static final String CANCELLED = "cancelled";
    static final String BAD_HASH = "bad-hash";
    static final String FAILED = "failed";

    static final String STRONGBOX = "strongbox";
    static final String TEE = "tee";
    static final String SOFTWARE_DEBUG = "software-debug";

    /** Set by {@link MainActivity}: a debug build launched to refuse a software key, as a release build does. */
    static volatile boolean strict = false;
    /** Set by {@link MainActivity}: a debug build launched to run the keys check. */
    static volatile boolean checkRequested = false;

    /** Keystore work is slow on StrongBox and never belongs on the UI thread. */
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    // status

    @PluginMethod
    public void status(PluginCall call) {
        worker.execute(() -> {
            JSObject answer = new JSObject();
            answer.put("platform", "android");
            answer.put("passcodeSet", passcodeSet());
            answer.put("hardwareKeystore", hardwareKeystore());
            answer.put("softwareFallback", softwareFallback());
            String backing = stored();
            answer.put("keys", backing == null ? JSONObject.NULL : new JSObject().put("backing", backing));
            answer.put("debugBuild", debuggable());
            answer.put("checkRequested", debuggable() && checkRequested);
            call.resolve(answer);
        });
    }

    private boolean passcodeSet() {
        return getContext().getSystemService(KeyguardManager.class).isDeviceSecure();
    }

    /**
     * The phone's own claim. An emulator makes it falsely, so creating the
     * key reads the level it actually got; before API 31 there is no claim
     * to read, and only that check decides.
     */
    private boolean hardwareKeystore() {
        if (Build.VERSION.SDK_INT < 31) return true;
        return getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_HARDWARE_KEYSTORE);
    }

    private boolean debuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private boolean softwareFallback() {
        return debuggable() && !strict;
    }

    // creating and deleting

    @PluginMethod
    public void createKeys(PluginCall call) {
        Log.i(BundleChannel.TAG, "DeviceKeys: creating the Device's keys");
        byte[] challenge = call.getString("challenge") == null ? random(32) : bytes(call.getString("challenge"));
        if (challenge == null || challenge.length > 128) {
            call.reject("an attestation challenge is at most 128 bytes of hex", FAILED);
            return;
        }
        worker.execute(() -> {
            if (!passcodeSet()) {
                call.reject("this phone has no screen lock", NO_PASSCODE);
                return;
            }
            if (!hardwareKeystore() && !softwareFallback()) {
                call.reject("this phone has no hardware keystore", NO_HARDWARE_KEYSTORE);
                return;
            }
            if (stored() != null) {
                call.reject("this phone already holds a Device's keys", KEYS_EXIST);
                return;
            }
            // What a creation that did not finish left behind.
            deleteAll();
            try {
                createHardwareKey(challenge);
                if (SOFTWARE_DEBUG.equals(backing()) && !softwareFallback()) {
                    deleteAll();
                    call.reject("this phone's keystore is software, not hardware", NO_HARDWARE_KEYSTORE);
                    return;
                }
                createNoiseKey();
                call.resolve(publicKeys());
            } catch (Exception e) {
                deleteAll();
                call.reject("the keys could not be made: " + e, FAILED);
            }
        });
    }

    private void createHardwareKey(byte[] challenge) throws Exception {
        boolean strongBox = getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
        try {
            generateHardwareKey(challenge, strongBox);
        } catch (StrongBoxUnavailableException e) {
            generateHardwareKey(challenge, false);
        }
    }

    private void generateHardwareKey(byte[] challenge, boolean strongBox) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        generator.initialize(new KeyGenParameterSpec.Builder(HARDWARE_ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(AUTH_WINDOW_SECONDS,
                KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .setUnlockedDeviceRequired(true)
            .setIsStrongBoxBacked(strongBox)
            .setAttestationChallenge(challenge)
            .build());
        generator.generateKeyPair();
    }

    /** 32 random bytes, sealed by a Keystore key that never leaves this phone. */
    private void createNoiseKey() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(NOISE_WRAP_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUnlockedDeviceRequired(true)
            .build());
        SecretKey wrap = generator.generateKey();
        byte[] noise = random(32);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrap);
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(noise);
        Arrays.fill(noise, (byte) 0);
        File target = noiseFile();
        File partial = new File(target.getPath() + ".partial");
        try (FileOutputStream out = new FileOutputStream(partial)) {
            out.write(iv);
            out.write(sealed);
            out.getFD().sync();
        }
        Files.move(partial.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    @PluginMethod
    public void deleteKeys(PluginCall call) {
        Log.i(BundleChannel.TAG, "DeviceKeys: deleting the Device's keys");
        worker.execute(() -> {
            deleteAll();
            call.resolve();
        });
    }

    private void deleteAll() {
        try {
            KeyStore keyStore = keyStore();
            for (String alias : new String[] {HARDWARE_ALIAS, NOISE_WRAP_ALIAS}) {
                if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias);
            }
        } catch (Exception e) {
            Log.w(BundleChannel.TAG, "DeviceKeys: could not delete a key: " + e);
        }
        noiseFile().delete();
    }

    // reading

    private static KeyStore keyStore() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        return keyStore;
    }

    private File noiseFile() {
        return new File(getContext().getNoBackupFilesDir(), NOISE_FILE);
    }

    /** The hardware key's backing, when both keys are here; else null. */
    private String stored() {
        try {
            KeyStore keyStore = keyStore();
            if (!keyStore.containsAlias(HARDWARE_ALIAS) || !keyStore.containsAlias(NOISE_WRAP_ALIAS)) return null;
            if (!noiseFile().isFile()) return null;
            return backing();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Where the hardware key actually is, read off the key. API 30 says
     * only whether it is in secure hardware, so there StrongBox reads as
     * the TEE; the attestation chain tells them apart on any level.
     */
    private String backing() throws Exception {
        PrivateKey key = (PrivateKey) keyStore().getKey(HARDWARE_ALIAS, null);
        KeyInfo info = KeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore").getKeySpec(key, KeyInfo.class);
        if (Build.VERSION.SDK_INT >= 31) {
            switch (info.getSecurityLevel()) {
                case KeyProperties.SECURITY_LEVEL_STRONGBOX:
                    return STRONGBOX;
                case KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT:
                case KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE:
                    return TEE;
                default:
                    return SOFTWARE_DEBUG;
            }
        }
        @SuppressWarnings("deprecation")
        boolean secure = info.isInsideSecureHardware();
        return secure ? TEE : SOFTWARE_DEBUG;
    }

    private JSObject publicKeys() throws Exception {
        KeyStore keyStore = keyStore();
        ECPublicKey key = (ECPublicKey) keyStore.getCertificate(HARDWARE_ALIAS).getPublicKey();
        // The uncompressed SEC1 point, 04 || X || Y, as iOS writes it.
        byte[] point = new byte[65];
        point[0] = 0x04;
        fixed(key.getW().getAffineX(), point, 1);
        fixed(key.getW().getAffineY(), point, 33);
        JSArray chain = new JSArray();
        Certificate[] certificates = keyStore.getCertificateChain(HARDWARE_ALIAS);
        if (certificates != null) {
            for (Certificate certificate : certificates) {
                chain.put(Base64.encodeToString(certificate.getEncoded(), Base64.NO_WRAP));
            }
        }
        JSObject answer = new JSObject();
        answer.put("hardwareKey", hex(point));
        answer.put("backing", backing());
        answer.put("attestation", chain);
        return answer;
    }

    @PluginMethod
    public void publicKeys(PluginCall call) {
        worker.execute(() -> {
            if (stored() == null) {
                call.reject("this phone holds no Device keys", NO_KEYS);
                return;
            }
            try {
                call.resolve(publicKeys());
            } catch (Exception e) {
                call.reject("the public keys could not be read: " + e, FAILED);
            }
        });
    }

    /** For the Companion core, in the shell's own web layer. Never a bundle's: no bundle can call this plugin. */
    @PluginMethod
    public void noiseKey(PluginCall call) {
        worker.execute(() -> {
            if (stored() == null) {
                call.reject("this phone holds no Device keys", NO_KEYS);
                return;
            }
            try {
                byte[] blob = Files.readAllBytes(noiseFile().toPath());
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                SecretKey wrap = (SecretKey) keyStore().getKey(NOISE_WRAP_ALIAS, null);
                cipher.init(Cipher.DECRYPT_MODE, wrap, new GCMParameterSpec(128, blob, 0, GCM_IV_BYTES));
                byte[] noise = cipher.doFinal(blob, GCM_IV_BYTES, blob.length - GCM_IV_BYTES);
                JSObject answer = new JSObject();
                answer.put("privateKey", hex(noise));
                Arrays.fill(noise, (byte) 0);
                call.resolve(answer);
            } catch (Exception e) {
                // A file sealed by another phone's key cannot be opened
                // here, and a Device that cannot read its key is not one.
                call.reject("the Noise key could not be read: " + e, FAILED);
            }
        });
    }

    // signing

    @PluginMethod
    public void sign(PluginCall call) {
        String reason = call.getString("reason", "");
        Log.i(BundleChannel.TAG, "DeviceKeys: asked to sign for “" + reason + "”");
        byte[] hash = bytes(call.getString("handshakeHash", ""));
        if (hash == null || hash.length != HANDSHAKE_HASH_BYTES) {
            call.reject("a handshake hash is " + HANDSHAKE_HASH_BYTES + " bytes of hex", BAD_HASH);
            return;
        }
        if (reason.isEmpty()) {
            call.reject("sign needs a reason to show the owner", FAILED);
            return;
        }
        worker.execute(() -> {
            if (stored() == null) {
                call.reject("this phone holds no Device keys", NO_KEYS);
                return;
            }
            getActivity().runOnUiThread(() -> askForOwner(call, reason, hash));
        });
    }

    private void askForOwner(PluginCall call, String reason, byte[] hash) {
        BiometricPrompt prompt = new BiometricPrompt.Builder(getActivity())
            .setTitle(reason)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG
                | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            .build();
        prompt.authenticate(new CancellationSignal(), getActivity().getMainExecutor(),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    worker.execute(() -> signNow(call, hash));
                }

                @Override
                public void onAuthenticationError(int code, CharSequence message) {
                    switch (code) {
                        case BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED:
                        case BiometricPrompt.BIOMETRIC_ERROR_CANCELED:
                        case BiometricPrompt.BIOMETRIC_ERROR_TIMEOUT:
                            call.reject("the owner did not confirm", CANCELLED);
                            break;
                        case BiometricPrompt.BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL:
                            call.reject("this phone has no screen lock", NO_PASSCODE);
                            break;
                        default:
                            call.reject("the owner could not be confirmed: " + message, FAILED);
                    }
                }
            });
    }

    /** ECDSA over SHA-256 of the unlock message, ASN.1 DER: what the daemon verifies. */
    private void signNow(PluginCall call, byte[] hash) {
        try {
            PrivateKey key = (PrivateKey) keyStore().getKey(HARDWARE_ALIAS, null);
            Signature signature = Signature.getInstance("SHA256withECDSA");
            signature.initSign(key);
            signature.update(UNLOCK_CONTEXT);
            signature.update(hash);
            JSObject answer = new JSObject();
            answer.put("signature", hex(signature.sign()));
            call.resolve(answer);
        } catch (KeyPermanentlyInvalidatedException e) {
            // The lock screen was removed: the key is gone for good, and
            // this phone must pair again as a new Device.
            deleteAll();
            call.reject("the key was invalidated when the screen lock was removed", NO_KEYS);
        } catch (Exception e) {
            call.reject("the key would not sign: " + e, FAILED);
        }
    }

    // helpers

    private static byte[] random(int length) {
        byte[] out = new byte[length];
        new SecureRandom().nextBytes(out);
        return out;
    }

    /** A coordinate as exactly 32 bytes, big-endian, at {@code offset}. */
    private static void fixed(BigInteger value, byte[] out, int offset) {
        byte[] raw = value.toByteArray();
        int start = Math.max(0, raw.length - 32);
        int length = raw.length - start;
        System.arraycopy(raw, start, out, offset + 32 - length, length);
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format("%02x", b & 0xff));
        return out.toString();
    }

    /** Hex to bytes, or null when it is not an even run of hex digits. */
    private static byte[] bytes(String hex) {
        if (hex == null || hex.length() % 2 != 0) return null;
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int high = Character.digit(hex.charAt(2 * i), 16);
            int low = Character.digit(hex.charAt(2 * i + 1), 16);
            if (high < 0 || low < 0) return null;
            out[i] = (byte) ((high << 4) | low);
        }
        return out;
    }
}
