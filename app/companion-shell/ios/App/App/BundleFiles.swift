import Foundation
import CryptoKit
import WebKit

/// Where a Workstation's bundle lives, and the origin it runs at.
///
/// Every Workstation gets an app-local origin of its own,
/// `gavin-bundle://<workstation>`: its storage is its own, and a message
/// can be told apart by where it came from. The Android shell's origin is
/// `https://<workstation>.bundle.gavin.invalid`; the shell's web layer
/// takes whichever the native side reports.
enum BundleOrigin {
    static let scheme = "gavin-bundle"

    static func origin(host: String) -> String {
        "\(scheme)://\(host)"
    }

    /// A Workstation id becomes the host of its origin, so it must be one:
    /// a DNS label (the web layer's `isWorkstationHost`).
    static func isHost(_ id: String) -> Bool {
        id.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil
    }

    /// An origin as a page would print it: `null` when it is opaque.
    static func describe(_ origin: WKSecurityOrigin) -> String {
        if origin.protocol.isEmpty { return "null" }
        let port = origin.port == 0 ? "" : ":\(origin.port)"
        return "\(origin.protocol)://\(origin.host)\(port)"
    }
}

/// Where a bundle's files are: embedded in this binary by `scripts/
/// sync.mjs` under `Bundles/` (the Demo Workstation's; the probe's in a
/// debug build), or installed in the cache by hash (`BundleCache`) after
/// the shell fetched and verified it (ADR 0005, companion-23).
enum BundleCatalog {
    /// The folder for the bundle `name` names: an embedded bundle's name,
    /// or a cached bundle's hash. Nothing else is served, whatever else
    /// sits in either place.
    static func folder(for name: String) -> URL? {
        if BundleCache.isHash(name) {
            return BundleCache.installed(name) ? BundleCache.folder(name) : nil
        }
        let embedded: Set<String>
        #if DEBUG
        // The probe is a debug build's only: `scripts/probe.sh`.
        embedded = ["demo", "probe"]
        #else
        embedded = ["demo"]
        #endif
        guard embedded.contains(name),
              let url = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "Bundles")
        else { return nil }
        return url
    }

    /// The public half of the dev bundle-signing key `scripts/sync.mjs`
    /// embedded, in a DEBUG build. A release build answers nil whatever
    /// the binary carries: a store build trusts the publisher key alone.
    static func devPublisherKey() -> String? {
        #if DEBUG
        guard let url = Bundle.main.url(forResource: "dev-bundle-key", withExtension: "json", subdirectory: "Bundles"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let key = json["publicKey"] as? String,
              key.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        else { return nil }
        return key
        #else
        return nil
        #endif
    }
}

/// The cache of served bundles, by content hash: `Library/Application
/// Support/bundles/<hash>/`, each folder one bundle's files, whole or
/// not there at all.
///
/// A bundle is written into a folder of its own beside the cache and
/// moved into place in one step, so a bundle that is being installed --
/// or one whose install failed -- is never served. Nothing but the
/// shell's web layer installs here, and only out of a bundle the
/// Companion core accepted; the paths are checked again on the way in.
/// The cache is a cache: excluded from backup, and pruned to the bundles
/// the paired Workstations serve.
enum BundleCache {
    static func isHash(_ name: String) -> Bool {
        name.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    static var root: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("bundles", isDirectory: true)
    }

    static func folder(_ hash: String) -> URL {
        root.appendingPathComponent(hash, isDirectory: true)
    }

    static func installed(_ hash: String) -> Bool {
        isHash(hash) && FileManager.default.fileExists(atPath: folder(hash).appendingPathComponent("index.html").path)
    }

    /// Whether a bundle's path may be written under its folder: relative,
    /// no segment that goes up or nowhere. The web layer and the core
    /// check the same; this is the last check before the write.
    static func isSafePath(_ path: String) -> Bool {
        !path.isEmpty
            && path.utf8.count <= 255
            && !path.hasPrefix("/")
            && !path.contains("\\")
            && !path.contains("\0")
            && path.split(separator: "/", omittingEmptySubsequences: false)
                .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    enum InstallError: Error, CustomStringConvertible {
        case notAHash
        case badPath(String)
        case notBase64(String)
        case noPage

        var description: String {
            switch self {
            case .notAHash: return "a bundle is installed under its hash"
            case .badPath(let path): return "\(path) is not a path a bundle may hold"
            case .notBase64(let path): return "\(path) is not base64"
            case .noPage: return "a bundle holds an index.html"
            }
        }
    }

    /// Writes `files` (`path` and base64 `data`) under `hash`, replacing
    /// a bundle already there under it.
    static func install(_ hash: String, files: [(path: String, data: String)]) throws {
        guard isHash(hash) else { throw InstallError.notAHash }
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var rootURL = root
        try? rootURL.setResourceValues(values)

        let staging = root.appendingPathComponent(".installing-\(hash)-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        var wrotePage = false
        do {
            for file in files {
                guard isSafePath(file.path) else { throw InstallError.badPath(file.path) }
                guard let bytes = Data(base64Encoded: file.data) else { throw InstallError.notBase64(file.path) }
                let target = staging.appendingPathComponent(file.path).standardizedFileURL
                guard target.path.hasPrefix(staging.standardizedFileURL.path + "/") else { throw InstallError.badPath(file.path) }
                try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try bytes.write(to: target, options: .atomic)
                if file.path == "index.html" { wrotePage = true }
            }
            guard wrotePage else { throw InstallError.noPage }
            let final = folder(hash)
            if fm.fileExists(atPath: final.path) { try fm.removeItem(at: final) }
            try fm.moveItem(at: staging, to: final)
        } catch {
            try? fm.removeItem(at: staging)
            throw error
        }
    }

    /// Removes every cached bundle whose hash is not in `keep`, and any
    /// install left half done.
    static func prune(keep: Set<String>) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for entry in entries {
            let name = entry.lastPathComponent
            if isHash(name) ? !keep.contains(name) : name.hasPrefix(".installing-") {
                try? fm.removeItem(at: entry)
            }
        }
    }
}

/// Serves one bundle's files at its origin, and nothing else.
///
/// Only requests for this Workstation's host reach a file, and only a file
/// inside its folder. Every HTML document carries a Content-Security-Policy
/// that leaves the page no way out but the channel: no network (`connect-src
/// 'self'`), no scripts but its own files and its own inline scripts,
/// hashed here the way Tauri hashes the desktop's.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let host: String
    private let root: URL

    init(host: String, root: URL) {
        self.host = host
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              url.scheme == BundleOrigin.scheme,
              url.host == host,
              url.port == nil
        else {
            respond(task, status: 403, type: "text/plain", body: Data())
            return
        }
        guard let file = resolve(url.path) else {
            respond(task, status: 404, type: "text/plain", body: Data())
            return
        }
        guard let body = try? Data(contentsOf: file) else {
            respond(task, status: 404, type: "text/plain", body: Data())
            return
        }
        let type = BundleSchemeHandler.mimeType(file.pathExtension)
        var headers: [String: String] = [:]
        if type.hasPrefix("text/html") {
            headers["Content-Security-Policy"] = BundleSchemeHandler.policy(html: String(decoding: body, as: UTF8.self))
        }
        respond(task, status: 200, type: type, body: body, headers: headers)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Every answer is written synchronously in `start`.
    }

    /// The file a path names, inside the bundle's folder. A path with no
    /// file and no extension is a route of the single-page app, and gets
    /// its page.
    private func resolve(_ path: String) -> URL? {
        let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let candidate = root.appendingPathComponent(relative.isEmpty ? "index.html" : relative).standardizedFileURL
        guard candidate.path == root.path || candidate.path.hasPrefix(root.path + "/") else { return nil }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) {
            if !isDirectory.boolValue { return candidate }
            let index = candidate.appendingPathComponent("index.html")
            return FileManager.default.fileExists(atPath: index.path) ? index : nil
        }
        if candidate.pathExtension.isEmpty {
            let index = root.appendingPathComponent("index.html")
            return FileManager.default.fileExists(atPath: index.path) ? index : nil
        }
        return nil
    }

    private func respond(_ task: WKURLSchemeTask, status: Int, type: String, body: Data, headers: [String: String] = [:]) {
        guard let url = task.request.url ?? URL(string: "\(BundleOrigin.scheme)://\(host)/") else { return }
        var fields = headers
        fields["Content-Type"] = type
        fields["Content-Length"] = String(body.count)
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields) else { return }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    /// The same policy the Android shell's `BundleFiles` builds. Keep the
    /// two in step.
    static func policy(html: String) -> String {
        let hashes = inlineScripts(html).map { script -> String in
            let digest = SHA256.hash(data: Data(script.utf8))
            return "'sha256-\(Data(digest).base64EncodedString())'"
        }
        return [
            "default-src 'self'",
            (["script-src 'self'"] + hashes).joined(separator: " "),
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
            "frame-ancestors 'none'",
        ].joined(separator: "; ")
    }

    private static let scriptPattern = try! NSRegularExpression(
        pattern: "<script\\b([^>]*)>([\\s\\S]*?)</script\\s*>",
        options: [.caseInsensitive]
    )

    /// The bodies of the page's inline scripts: every `<script>` without a
    /// `src`.
    static func inlineScripts(_ html: String) -> [String] {
        let range = NSRange(html.startIndex..., in: html)
        return scriptPattern.matches(in: html, range: range).compactMap { match in
            guard let attributes = Range(match.range(at: 1), in: html),
                  let body = Range(match.range(at: 2), in: html)
            else { return nil }
            if html[attributes].range(of: "\\bsrc\\s*=", options: [.regularExpression, .caseInsensitive]) != nil {
                return nil
            }
            return String(html[body])
        }
    }

    static func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
