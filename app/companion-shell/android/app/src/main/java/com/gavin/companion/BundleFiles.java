package com.gavin.companion;

import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.util.Base64;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where a Workstation's bundle lives, the origin it runs at, and the files
 * served there.
 *
 * <p>Every Workstation gets an app-local origin of its own,
 * {@code https://<workstation>.bundle.gavin.invalid}. {@code .invalid} can
 * never resolve (RFC 2606), so nothing but this app's interception ever
 * answers it; it is https so the page is a secure context. The iOS shell's
 * origin is {@code gavin-bundle://<workstation>}; the shell's web layer
 * takes whichever the native side reports.
 *
 * <p>A bundle's files are embedded by {@code scripts/sync.mjs} under
 * {@code assets/bundles/} -- the Demo Workstation's in every build, the
 * probe's in debug builds only ({@code src/debug/assets}) -- or installed
 * in the cache by hash ({@link BundleCache}) after the shell fetched and
 * verified them (ADR 0005, companion-23). {@link #source} names which.
 */
final class BundleFiles {
    static final String DOMAIN = ".bundle.gavin.invalid";

    private static final Pattern HOST = Pattern.compile("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$");

    /** Where one bundle's files are read from. */
    interface Source {
        /** The file at {@code relative}, or null. */
        byte[] read(String relative);
    }

    /** An embedded bundle: {@code assets/bundles/<name>/}. */
    static final class AssetSource implements Source {
        private final AssetManager assets;
        private final String name;

        AssetSource(AssetManager assets, String name) {
            this.assets = assets;
            this.name = name;
        }

        @Override
        public byte[] read(String relative) {
            try (InputStream in = assets.open("bundles/" + name + "/" + relative)) {
                return readAll(in);
            } catch (IOException e) {
                return null;
            }
        }
    }

    /** A cached bundle: a folder of files, and nothing outside it. */
    static final class DirSource implements Source {
        private final File root;

        DirSource(File root) {
            this.root = root;
        }

        @Override
        public byte[] read(String relative) {
            File file = new File(root, relative);
            try {
                if (!file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) return null;
                if (!file.isFile()) return null;
                try (InputStream in = new FileInputStream(file)) {
                    return readAll(in);
                }
            } catch (IOException e) {
                return null;
            }
        }
    }

    private final Source source;
    private final String workstation;

    BundleFiles(Source source, String workstation) {
        this.source = source;
        this.workstation = workstation;
    }

    /**
     * The files the bundle {@code name} names: an embedded bundle's name,
     * or a cached bundle's hash. Null when this app has neither.
     */
    static Source source(Context context, String name) {
        if (name == null) return null;
        if (BundleCache.isHash(name)) {
            return BundleCache.installed(context, name) ? new DirSource(BundleCache.folder(context, name)) : null;
        }
        return carries(context.getAssets(), name) ? new AssetSource(context.getAssets(), name) : null;
    }

    /** A Workstation id becomes a host name, so it must be one (a DNS label). */
    static boolean isHost(String id) {
        return id != null && HOST.matcher(id).matches();
    }

    static String host(String workstation) {
        return workstation + DOMAIN;
    }

    static String origin(String workstation) {
        return "https://" + host(workstation);
    }

    /** Whether this build carries a bundle for {@code workstation}. */
    static boolean carries(AssetManager assets, String workstation) {
        if (!isHost(workstation)) return false;
        try (InputStream ignored = assets.open("bundles/" + workstation + "/index.html")) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    boolean isOwn(Uri url) {
        return "https".equals(url.getScheme()) && host(workstation).equals(url.getHost()) && url.getPort() == -1;
    }

    /** The answer to a request for one of this bundle's own URLs. */
    WebResourceResponse serve(Uri url) {
        String path = url.getPath() == null ? "" : url.getPath();
        String relative = path.startsWith("/") ? path.substring(1) : path;
        if (relative.isEmpty()) relative = "index.html";
        if (!safe(relative)) return status(403);
        byte[] body = read(relative);
        if (body == null && relative.endsWith("/")) {
            relative = relative + "index.html";
            body = read(relative);
        }
        if (body == null && extension(relative).isEmpty()) {
            // A route of the single-page app: its page.
            relative = "index.html";
            body = read(relative);
        }
        if (body == null) return status(404);

        String[] type = mimeType(extension(relative));
        Map<String, String> headers = new HashMap<>();
        if ("text/html".equals(type[0])) {
            headers.put("Content-Security-Policy", policy(new String(body, StandardCharsets.UTF_8)));
        }
        return new WebResourceResponse(type[0], type[1], 200, "OK", headers, new ByteArrayInputStream(body));
    }

    /** Anything that is not this bundle's: refused here, never fetched. */
    static WebResourceResponse refused() {
        return status(403);
    }

    private static WebResourceResponse status(int code) {
        return new WebResourceResponse(
            "text/plain", "utf-8", code, code == 404 ? "Not Found" : "Forbidden",
            new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    /** No way out of the bundle's folder. */
    private static boolean safe(String relative) {
        for (String segment : relative.split("/", -1)) {
            if (segment.equals("..") || segment.equals(".")) return false;
        }
        return !relative.contains("\\");
    }

    private byte[] read(String relative) {
        return source.read(relative);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int n;
        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        return out.toByteArray();
    }

    private static String extension(String path) {
        int slash = path.lastIndexOf('/');
        int dot = path.lastIndexOf('.');
        return dot > slash ? path.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
    }

    /** The same policy the iOS shell's {@code BundleSchemeHandler} builds. Keep the two in step. */
    static String policy(String html) {
        StringBuilder scripts = new StringBuilder("script-src 'self'");
        for (String script : inlineScripts(html)) {
            scripts.append(" 'sha256-").append(sha256(script)).append("'");
        }
        return String.join("; ",
            "default-src 'self'",
            scripts.toString(),
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "media-src 'self' data: blob:",
            "connect-src 'self'",
            "worker-src 'self' blob:",
            "frame-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'none'",
            "frame-ancestors 'none'");
    }

    private static final Pattern SCRIPT =
        Pattern.compile("<script\\b([^>]*)>([\\s\\S]*?)</script\\s*>", Pattern.CASE_INSENSITIVE);
    private static final Pattern SRC = Pattern.compile("\\bsrc\\s*=", Pattern.CASE_INSENSITIVE);

    /** The bodies of the page's inline scripts: every {@code <script>} without a {@code src}. */
    static List<String> inlineScripts(String html) {
        List<String> found = new ArrayList<>();
        Matcher m = SCRIPT.matcher(html);
        while (m.find()) {
            if (SRC.matcher(m.group(1)).find()) continue;
            found.add(m.group(2));
        }
        return found;
    }

    private static String sha256(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(digest, Base64.NO_WRAP);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** {mime type, encoding}. */
    private static String[] mimeType(String ext) {
        switch (ext) {
            case "html": case "htm": return new String[] {"text/html", "utf-8"};
            case "js": case "mjs": return new String[] {"text/javascript", "utf-8"};
            case "css": return new String[] {"text/css", "utf-8"};
            case "json": case "map": return new String[] {"application/json", "utf-8"};
            case "svg": return new String[] {"image/svg+xml", null};
            case "png": return new String[] {"image/png", null};
            case "jpg": case "jpeg": return new String[] {"image/jpeg", null};
            case "gif": return new String[] {"image/gif", null};
            case "webp": return new String[] {"image/webp", null};
            case "ico": return new String[] {"image/x-icon", null};
            case "woff": return new String[] {"font/woff", null};
            case "woff2": return new String[] {"font/woff2", null};
            case "ttf": return new String[] {"font/ttf", null};
            case "wasm": return new String[] {"application/wasm", null};
            case "txt": return new String[] {"text/plain", "utf-8"};
            default: return new String[] {"application/octet-stream", null};
        }
    }
}
