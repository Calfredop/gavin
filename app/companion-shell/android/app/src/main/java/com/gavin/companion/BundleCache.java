package com.gavin.companion;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.res.AssetManager;
import android.util.Base64;

import com.getcapacitor.JSArray;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The cache of served bundles, by content hash: {@code
 * <noBackupFilesDir>/bundles/<hash>/}, each folder one bundle's files,
 * whole or not there at all (ADR 0005, companion-23).
 *
 * <p>A bundle is written into a folder of its own beside the cache and
 * renamed into place in one step, so a bundle that is being installed --
 * or one whose install failed -- is never served. Nothing but the shell's
 * web layer installs here, and only out of a bundle the Companion core
 * accepted; the paths are checked again on the way in. The cache is under
 * the no-backup directory: a bundle is fetched again, never restored.
 *
 * <p>The shell's process installs and prunes; the bundle's process
 * ({@code :bundle}) reads. Both are this app, so the directory is one.
 */
final class BundleCache {
    private static final Pattern HASH = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern KEY = Pattern.compile("^[0-9a-f]{64}$");

    private BundleCache() {}

    static boolean isHash(String name) {
        return name != null && HASH.matcher(name).matches();
    }

    static File root(Context context) {
        return new File(context.getNoBackupFilesDir(), "bundles");
    }

    static File folder(Context context, String hash) {
        return new File(root(context), hash);
    }

    static boolean installed(Context context, String hash) {
        return isHash(hash) && new File(folder(context, hash), "index.html").isFile();
    }

    /** Whether a bundle's path may be written under its folder. */
    static boolean isSafePath(String path) {
        if (path == null || path.isEmpty() || path.getBytes(StandardCharsets.UTF_8).length > 255) return false;
        if (path.startsWith("/") || path.contains("\\") || path.indexOf('\0') >= 0) return false;
        for (String segment : path.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) return false;
        }
        return true;
    }

    /**
     * Writes {@code files} (objects with {@code path} and base64 {@code
     * data}) under {@code hash}, replacing a bundle already there.
     */
    static void install(Context context, String hash, JSArray files) throws IOException, JSONException {
        if (!isHash(hash)) throw new IOException("a bundle is installed under its hash");
        File root = root(context);
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("cannot make " + root);
        File staging = new File(root, ".installing-" + hash + "-" + UUID.randomUUID());
        if (!staging.mkdirs()) throw new IOException("cannot make " + staging);
        boolean wrotePage = false;
        try {
            String stagingPath = staging.getCanonicalPath() + File.separator;
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.getJSONObject(i);
                String path = file.getString("path");
                if (!isSafePath(path)) throw new IOException(path + " is not a path a bundle may hold");
                byte[] bytes;
                try {
                    bytes = Base64.decode(file.getString("data"), Base64.DEFAULT);
                } catch (IllegalArgumentException e) {
                    throw new IOException(path + " is not base64");
                }
                File target = new File(staging, path);
                if (!target.getCanonicalPath().startsWith(stagingPath)) throw new IOException(path + " is not a path a bundle may hold");
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot make " + parent);
                try (FileOutputStream out = new FileOutputStream(target)) {
                    out.write(bytes);
                }
                if (path.equals("index.html")) wrotePage = true;
            }
            if (!wrotePage) throw new IOException("a bundle holds an index.html");
            File finalFolder = folder(context, hash);
            if (finalFolder.exists()) delete(finalFolder);
            if (!staging.renameTo(finalFolder)) throw new IOException("cannot move the bundle into place");
        } catch (IOException | JSONException e) {
            delete(staging);
            throw e;
        }
    }

    /** Removes every cached bundle whose hash is not in {@code keep}, and any install left half done. */
    static void prune(Context context, Set<String> keep) {
        File[] entries = root(context).listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            String name = entry.getName();
            boolean stale = isHash(name) ? !keep.contains(name) : name.startsWith(".installing-");
            if (stale) delete(entry);
        }
    }

    /**
     * The public half of the dev bundle-signing key {@code scripts/sync.mjs}
     * embedded in the debug source set, in a debuggable build. A release
     * build carries no such asset and answers null either way: a store
     * build trusts the publisher key alone.
     */
    static String devPublisherKey(Context context) {
        boolean debuggable = (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable) return null;
        AssetManager assets = context.getAssets();
        try (InputStream in = assets.open("dev-bundle-key.json")) {
            byte[] buffer = new byte[4096];
            int n = in.read(buffer);
            if (n <= 0) return null;
            JSONObject json = new JSONObject(new String(buffer, 0, n, StandardCharsets.UTF_8));
            String key = json.optString("publicKey", null);
            return key != null && KEY.matcher(key).matches() ? key : null;
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
