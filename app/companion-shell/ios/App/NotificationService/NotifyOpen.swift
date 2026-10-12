//
//  NotifyOpen.swift
//  Companion — Notification Service Extension
//
//  Opens a Companion push: the format crates/daemon/src/notify_crypto.rs
//  seals, and held to it byte for byte by the table both read,
//  test-fixtures/companion-notify/cases.json (scripts/notify-fixture.sh
//  runs this file over it on a Mac). Foundation and CryptoKit only, so the
//  one file builds into the extension and into that check.
//
//  `c` is the nonce (12 bytes), then ChaCha20-Poly1305's ciphertext and
//  tag. The plaintext is a version byte (1), the Workstation's counter and
//  the issue time (each a big-endian u64), the JSON, and padding to a
//  256-byte bucket whose bytes each say how many there are -- a whole
//  bucket of it, 256, written as 0.
//

import CryptoKit
import Foundation

/// Why a push did not open, by the names the table gives them.
enum NotifyOpenError: Error, Equatable {
    case key
    case truncated
    case decrypt
    case version(UInt8)
    case malformed(String)

    var name: String {
        switch self {
        case .key: return "key"
        case .truncated: return "truncated"
        case .decrypt: return "decrypt"
        case .version: return "version"
        case .malformed: return "malformed"
        }
    }
}

enum NotifyTarget: Equatable {
    case session(id: String)
    case card(path: String)
}

/// `NotifyPlaintext` in notify_crypto.rs.
struct NotifyBody: Equatable {
    enum Op: String {
        case notify
        case resolve
    }

    let op: Op
    let id: String
    let kind: String?
    let text: String?
    let workspaceId: String?
    let target: NotifyTarget?
}

struct OpenedNotify: Equatable {
    let counter: UInt64
    let issuedAt: UInt64
    let body: NotifyBody
}

enum NotifyFormat {
    static let keyLength = 32
    static let nonceLength = 12
    static let padBucket = 256
    static let version: UInt8 = 1
    /// What the lock screen says when nothing opened: the Push gateway's
    /// own placeholder (docs/push-gateway.md), which names no Workstation.
    static let genericBody = "Something on your Workstation changed."
    /// Where a tap lands when there is nowhere better: the hub.
    static let hubLink = "gavin://hub"
}

/// Opens `sealed` with one Workstation's notification key. A key that is
/// not this push's fails as `decrypt`, which is how the extension tells
/// which Workstation sent it.
func openNotify(key: Data, sealed: Data) throws -> OpenedNotify {
    guard key.count == NotifyFormat.keyLength else { throw NotifyOpenError.key }
    guard sealed.count > NotifyFormat.nonceLength else { throw NotifyOpenError.truncated }
    let plain: [UInt8]
    do {
        // Shorter than a nonce and a tag is refused here, as the daemon's
        // AEAD refuses it: a decrypt failure, not a truncation.
        let box = try ChaChaPoly.SealedBox(combined: sealed)
        plain = [UInt8](try ChaChaPoly.open(box, using: SymmetricKey(data: key)))
    } catch {
        throw NotifyOpenError.decrypt
    }
    guard plain.count >= 1 + 8 + 8 else { throw NotifyOpenError.truncated }
    guard plain[0] == NotifyFormat.version else { throw NotifyOpenError.version(plain[0]) }
    let counter = bigEndian(plain[1..<9])
    let issuedAt = bigEndian(plain[9..<17])
    let json = try unpad(Array(plain[17...]))
    return OpenedNotify(counter: counter, issuedAt: issuedAt, body: try readBody(json))
}

private func bigEndian(_ bytes: ArraySlice<UInt8>) -> UInt64 {
    bytes.reduce(0) { ($0 << 8) | UInt64($1) }
}

private func unpad(_ buf: [UInt8]) throws -> [UInt8] {
    guard let byte = buf.last else { throw NotifyOpenError.malformed("empty") }
    let n = byte == 0 ? NotifyFormat.padBucket : Int(byte)
    guard n <= buf.count, buf[(buf.count - n)...].allSatisfy({ $0 == byte }) else {
        throw NotifyOpenError.malformed("bad pad")
    }
    return Array(buf[..<(buf.count - n)])
}

/// Reads the JSON as serde reads it into `NotifyPlaintext`: a field this
/// build does not know is passed over, and one it knows with the wrong
/// type, a missing `op` or `id`, or a target of a kind it cannot name, is
/// refused.
private func readBody(_ json: [UInt8]) throws -> NotifyBody {
    let object: [String: Any]
    do {
        guard let read = try JSONSerialization.jsonObject(with: Data(json)) as? [String: Any] else {
            throw NotifyOpenError.malformed("not an object")
        }
        object = read
    } catch let error as NotifyOpenError {
        throw error
    } catch {
        throw NotifyOpenError.malformed("not JSON")
    }
    guard let opName = object["op"] as? String, let op = NotifyBody.Op(rawValue: opName) else {
        throw NotifyOpenError.malformed("op")
    }
    guard let id = object["id"] as? String else { throw NotifyOpenError.malformed("id") }
    return NotifyBody(
        op: op,
        id: id,
        kind: try optionalString(object, "kind"),
        text: try optionalString(object, "text"),
        workspaceId: try optionalString(object, "workspace_id"),
        target: try readTarget(object["target"])
    )
}

private func optionalString(_ object: [String: Any], _ field: String) throws -> String? {
    switch object[field] {
    case nil, is NSNull: return nil
    case let value as String: return value
    default: throw NotifyOpenError.malformed(field)
    }
}

private func readTarget(_ value: Any?) throws -> NotifyTarget? {
    if value == nil || value is NSNull { return nil }
    guard let target = value as? [String: Any] else { throw NotifyOpenError.malformed("target") }
    switch target["type"] as? String {
    case "session":
        guard let id = target["session_id"] as? String else { throw NotifyOpenError.malformed("session_id") }
        return .session(id: id)
    case "card":
        guard let path = target["path"] as? String else { throw NotifyOpenError.malformed("path") }
        return .card(path: path)
    default:
        throw NotifyOpenError.malformed("target type")
    }
}

/// Where a tap lands: `deepLinkFor` in src/shell/push/decrypt.ts, which
/// reads it back, held to this by the table's `link`. A resolve, or
/// nothing opened, lands on the hub.
func notifyLink(_ body: NotifyBody?, workstation: String?) -> String {
    guard let body, let workstation, body.op == .notify else { return NotifyFormat.hubLink }
    var link = "gavin://ws/\(workstation)"
    var query: [String] = []
    switch body.target {
    case .session(let id)?:
        link += "/session/\(uriComponent(id))"
    case .card(let path)?:
        link += "/card"
        query.append("path=\(uriComponent(path))")
    case nil:
        break
    }
    if let workspace = body.workspaceId { query.append("workspace=\(uriComponent(workspace))") }
    return query.isEmpty ? link : "\(link)?\(query.joined(separator: "&"))"
}

/// What JavaScript's `encodeURIComponent` leaves as it is.
private let uriComponentKept = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
)

private func uriComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: uriComponentKept) ?? ""
}
