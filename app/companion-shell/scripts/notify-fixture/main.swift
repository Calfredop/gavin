// The Notification Service Extension's open, run over the table the
// daemon's seal is held to (test-fixtures/companion-notify/cases.json).
// Built with ios/App/NotificationService/NotifyOpen.swift by
// scripts/notify-fixture.sh; prints a line a case and exits 1 when any
// case reads differently here than the table says.
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("notify-fixture: \(message)\n".utf8))
    exit(2)
}

guard CommandLine.arguments.count == 2 else { fail("usage: notify-fixture <cases.json>") }
guard
    let data = FileManager.default.contents(atPath: CommandLine.arguments[1]),
    let table = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let workstation = table["workstation"] as? String,
    let cases = table["cases"] as? [[String: Any]]
else { fail("\(CommandLine.arguments[1]) is not the notification table") }

func hex(_ text: String) -> Data {
    var bytes = [UInt8]()
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(index, offsetBy: 2)
        guard let byte = UInt8(text[index..<next], radix: 16) else { fail("\(text) is not hex") }
        bytes.append(byte)
        index = next
    }
    return Data(bytes)
}

func expectedBody(_ object: [String: Any]) -> NotifyBody {
    var target: NotifyTarget?
    if let t = object["target"] as? [String: Any] {
        target = t["type"] as? String == "session"
            ? .session(id: t["session_id"] as! String)
            : .card(path: t["path"] as! String)
    }
    return NotifyBody(
        op: NotifyBody.Op(rawValue: object["op"] as! String)!,
        id: object["id"] as! String,
        kind: object["kind"] as? String,
        text: object["text"] as? String,
        workspaceId: object["workspace_id"] as? String,
        target: target
    )
}

var failed = 0
for entry in cases {
    let name = entry["name"] as? String ?? "?"
    let key = hex(entry["key"] as! String)
    guard let sealed = Data(base64Encoded: entry["c"] as! String) else { fail("\(name): c is not base64") }
    let link = entry["link"] as! String
    var problems: [String] = []
    var opened: OpenedNotify?
    var refusal: NotifyOpenError?
    do {
        opened = try openNotify(key: key, sealed: sealed)
    } catch let error as NotifyOpenError {
        refusal = error
    } catch {
        problems.append("threw \(error)")
    }
    if let opens = entry["opens"] as? [String: Any] {
        if let opened {
            if opened.counter != (opens["counter"] as! NSNumber).uint64Value { problems.append("counter \(opened.counter)") }
            if opened.issuedAt != (opens["issued_at"] as! NSNumber).uint64Value { problems.append("issued_at \(opened.issuedAt)") }
            let body = expectedBody(opens["body"] as! [String: Any])
            if opened.body != body { problems.append("body \(opened.body), the table says \(body)") }
        } else {
            problems.append("refused (\(refusal.map { "\($0)" } ?? "?")); the table says it opens")
        }
    } else if let why = entry["refuse"] as? String {
        if let refusal {
            if refusal.name != why { problems.append("refused as \(refusal.name), the table says \(why)") }
        } else {
            problems.append("opened; the table says \(why)")
        }
    } else {
        fail("\(name) must say exactly one of opens and refuse")
    }
    let landed = notifyLink(opened?.body, workstation: workstation)
    if landed != link { problems.append("lands on \(landed), the table says \(link)") }

    if problems.isEmpty {
        print("ok   \(name)")
    } else {
        failed += 1
        print("FAIL \(name): \(problems.joined(separator: "; "))")
    }
}
print("\(cases.count - failed) of \(cases.count) cases read as the table says")
exit(failed == 0 && cases.count >= 13 ? 0 : 1)
