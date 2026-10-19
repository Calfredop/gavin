package com.gavin.companion;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Script-only debug triggers for a debuggable Companion.
 *
 * <p>Requests live as files under the app's private {@code files/gavin-debug/}
 * directory, which only the app itself and {@code adb shell run-as
 * com.gavin.companion} can write. Intent extras on the exported launcher are
 * ignored: any co-installed app can start {@link MainActivity} with those.
 *
 * <p>Each request is consumed when read, so a later launch by anyone sees
 * nothing. Release (non-debuggable) builds ignore the directory entirely.
 */
final class DebugLaunch {
    static final String DIR = "gavin-debug";
    static final String KEYS_CHECK = "keys-check";
    static final String STRICT_KEYS = "strict-keys";
    static final String BUNDLE_PROBE = "bundle-probe";
    static final String OPEN_FIRST = "open-first";
    static final String PAIR_CODE = "pair-code";

    final boolean keysCheck;
    final boolean strictKeys;
    final boolean bundleProbe;
    final boolean openFirst;
    final String pairCode;

    DebugLaunch(boolean keysCheck, boolean strictKeys, boolean bundleProbe, boolean openFirst, String pairCode) {
        this.keysCheck = keysCheck;
        this.strictKeys = strictKeys;
        this.bundleProbe = bundleProbe;
        this.openFirst = openFirst;
        this.pairCode = pairCode;
    }

    /**
     * Reads and deletes request files under {@code filesDir/gavin-debug}.
     * When {@code debuggable} is false, returns an empty request and leaves
     * any files untouched.
     */
    static DebugLaunch consume(File filesDir, boolean debuggable) {
        if (!debuggable || filesDir == null) {
            return new DebugLaunch(false, false, false, false, null);
        }
        File dir = new File(filesDir, DIR);
        boolean keysCheck = takeFlag(new File(dir, KEYS_CHECK));
        boolean strictKeys = takeFlag(new File(dir, STRICT_KEYS));
        boolean bundleProbe = takeFlag(new File(dir, BUNDLE_PROBE));
        boolean openFirst = takeFlag(new File(dir, OPEN_FIRST));
        String pairCode = takeText(new File(dir, PAIR_CODE));
        return new DebugLaunch(keysCheck, strictKeys, bundleProbe, openFirst, pairCode);
    }

    private static boolean takeFlag(File file) {
        if (!file.isFile()) return false;
        //noinspection ResultOfMethodCallIgnored
        file.delete();
        return true;
    }

    private static String takeText(File file) {
        if (!file.isFile()) return null;
        try {
            String text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).trim();
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return text.isEmpty() ? null : text;
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return null;
        }
    }
}
