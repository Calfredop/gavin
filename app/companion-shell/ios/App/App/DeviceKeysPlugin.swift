import Foundation
import Capacitor
import CryptoKit
import LocalAuthentication
import Security
import UIKit

/// The Device's two keys (ADR 0001), as the shell's web layer drives them
/// (`src/shell/native/deviceKeys.ts`).
///
/// Registered on the shell's own Capacitor webview only. A bundle cannot
/// call it: its webview has no bridge.
///
/// - **The hardware key** is a Secure Enclave P-256 key whose access
///   control asks for the owner -- Face ID or Touch ID, falling back to the
///   passcode -- before it signs, and which exists only while a passcode
///   is set. It signs one kind of message: `unlockContext` followed by a
///   32-byte handshake hash, built here, so that nothing can ask it to
///   sign bytes that mean something anywhere else.
/// - **The Noise key** is 32 random bytes in a keychain item this device
///   only, never synchronised. It goes to the shell's web layer, where the
///   Companion core does the Diffie-Hellman (ADR 0002).
///
/// A Simulator has a Secure Enclave but refuses every key that requires
/// the owner (-25293), so a debug build there uses a software P-256 key,
/// marked `software-debug`, which only a debug daemon accepts. The prompt
/// is still real; the gate behind it is not
/// (`docs/research/2026-09-28-companion-device-keys.md`).
///
/// `sign` asks for the owner every time: pairing. The Unlock (ADR 0004) is
/// `unlock`, which asks once and holds the evaluated `LAContext`, and
/// `signUnlocked`, which signs through that context and never shows
/// anything -- every connection, to every Workstation, for as long as the
/// app stays in front. The context is invalidated when the app goes to the
/// background or the phone locks (`didEnterBackground`,
/// `protectedDataWillBecomeUnavailable`), never when it merely resigns
/// active: Control Center, a call banner and the Face ID sheet itself do
/// that (`docs/research/2026-09-28-companion-device-keys.md`, "Brief
/// interruptions"). Each of those is also told to the web layer as a
/// `lifecycle` event, with coming back to the front.
@objc(DeviceKeysPlugin)
public class DeviceKeysPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceKeysPlugin"
    public let jsName = "DeviceKeys"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publicKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "noiseKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signUnlocked", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlockState", returnType: CAPPluginReturnPromise),
    ]

    /// What the hardware key signs ahead of the handshake hash: the wire's
    /// `device_wire::unlock_message`.
    static let unlockContext = Data("gavin-device-unlock-v1".utf8)
    static let handshakeHashBytes = 32

    static let hardwareTag = Data("com.gavin.companion.device-key".utf8)
    static let softwareService = "com.gavin.companion.device-key.software-debug"
    static let noiseService = "com.gavin.companion.noise-key"
    static let account = "device"
    /// In UserDefaults, which an uninstall removes -- unlike the keychain.
    static let installedMarker = "com.gavin.companion.device-keys.installed"

    enum Refusal: String {
        case noPasscode = "no-passcode"
        case noHardwareKeystore = "no-hardware-keystore"
        case keysExist = "keys-exist"
        case noKeys = "no-keys"
        case cancelled
        case badHash = "bad-hash"
        case locked
        case unlockExpired = "unlock-expired"
        case background
        case failed
    }

    enum Backing: String {
        case secureEnclave = "secure-enclave"
        case softwareDebug = "software-debug"
    }

    static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    static var debugBuild: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    /// A Simulator's Secure Enclave cannot hold a key that requires the
    /// owner, so it does not count.
    static var hardwareKeystore: Bool { !isSimulator && SecureEnclave.isAvailable }

    /// Only a debug build, only on a Simulator, and not when launched with
    /// `-GavinStrictKeys YES` (scripts/keys.sh --strict), which makes it
    /// refuse as a release build would.
    static var softwareFallback: Bool {
        #if DEBUG
        return isSimulator && !UserDefaults.standard.bool(forKey: "GavinStrictKeys")
        #else
        return false
        #endif
    }

    /// Launched with `-GavinKeysCheck YES` (scripts/keys.sh). Never in a
    /// release build.
    static var checkRequested: Bool {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "GavinKeysCheck")
        #else
        return false
        #endif
    }

    override public func load() {
        // iOS keeps keychain items across an uninstall. A reinstall must be
        // a new Device that pairs again, never the old one revived, so the
        // first launch throws away whatever an earlier install left.
        if !UserDefaults.standard.bool(forKey: Self.installedMarker) {
            Self.deleteAll()
            UserDefaults.standard.set(true, forKey: Self.installedMarker)
        }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didEnterBackground),
                           name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(phoneWillLock),
                           name: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil)
        center.addObserver(self, selector: #selector(willEnterForeground),
                           name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    // MARK: the Unlock

    /// The authentication the Unlock holds, and the key it unlocks. Only
    /// ever read or replaced under `heldLock`: prompts answer on a queue of
    /// their own, and lifecycle notifications on the main thread.
    private var held: (context: LAContext, backing: Backing)?
    private let heldLock = NSLock()

    private func hold(_ next: (context: LAContext, backing: Backing)?) {
        heldLock.lock()
        let before = held
        held = next
        heldLock.unlock()
        if let before, before.context !== next?.context { before.context.invalidate() }
    }

    private func current() -> (context: LAContext, backing: Backing)? {
        heldLock.lock()
        defer { heldLock.unlock() }
        return held
    }

    @objc private func didEnterBackground() {
        NSLog("[gavin-shell] DeviceKeys: the app went to the background; the Unlock ends")
        hold(nil)
        notifyListeners("lifecycle", data: ["phase": "background"])
    }

    @objc private func phoneWillLock() {
        NSLog("[gavin-shell] DeviceKeys: the phone is locking; the Unlock ends")
        hold(nil)
        notifyListeners("lifecycle", data: ["phase": "screen-locked"])
    }

    @objc private func willEnterForeground() {
        notifyListeners("lifecycle", data: ["phase": "foreground"])
    }

    /// Asks for the owner once, and holds that for `signUnlocked`.
    @objc func unlock(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? ""
        guard !reason.isEmpty else {
            reject(call, .failed, "unlock needs a reason to show the owner")
            return
        }
        guard let backing = Self.stored() else {
            reject(call, .noKeys, "this phone holds no Device keys")
            return
        }
        NSLog("[gavin-shell] DeviceKeys: asked to unlock")
        let context = LAContext()
        evaluate(context, backing: backing, reason: reason, call: call) {
            DispatchQueue.main.async {
                // A prompt answered after the app left the front -- the
                // phone locked with it up -- unlocks nothing.
                guard UIApplication.shared.applicationState != .background else {
                    context.invalidate()
                    self.reject(call, .background, "the app went to the background while the owner was asked")
                    return
                }
                // From here the context authorises the key without showing
                // anything more: a signature is made, or it fails.
                context.interactionNotAllowed = true
                self.hold((context, backing))
                NSLog("[gavin-shell] DeviceKeys: unlocked")
                call.resolve()
            }
        }
    }

    /// Signs under the held Unlock, never asking.
    @objc func signUnlocked(_ call: CAPPluginCall) {
        guard let hash = Self.bytes(hex: call.getString("handshakeHash") ?? ""), hash.count == Self.handshakeHashBytes else {
            reject(call, .badHash, "a handshake hash is \(Self.handshakeHashBytes) bytes of hex")
            return
        }
        guard let (context, backing) = current() else {
            reject(call, .locked, "no Unlock is held")
            return
        }
        do {
            let signature = try Self.signature(of: Self.unlockContext + hash, backing: backing, through: context)
            call.resolve(["signature": Self.hex(signature)])
        } catch {
            // Ended meanwhile -- the app went to the background, or the
            // phone locked, as it signed: that is locked, not lapsed.
            guard current()?.context === context else {
                reject(call, .locked, "the Unlock ended while it signed")
                return
            }
            // The held context no longer authorises the key: the Unlock
            // is over, and a new one is needed.
            hold(nil)
            reject(call, .unlockExpired, "the key would not sign under the Unlock: \(error.localizedDescription)")
        }
    }

    @objc func lock(_ call: CAPPluginCall) {
        hold(nil)
        call.resolve()
    }

    @objc func unlockState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve([
                "unlocked": self.current() != nil,
                "foreground": UIApplication.shared.applicationState != .background,
            ])
        }
    }

    // MARK: status

    static func passcodeSet() -> Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve([
            "platform": "ios",
            "passcodeSet": Self.passcodeSet(),
            "hardwareKeystore": Self.hardwareKeystore,
            "softwareFallback": Self.softwareFallback,
            "keys": Self.stored().map { ["backing": $0.rawValue] as Any } ?? NSNull(),
            "debugBuild": Self.debugBuild,
            "checkRequested": Self.checkRequested,
        ])
    }

    // MARK: creating and deleting

    @objc func createKeys(_ call: CAPPluginCall) {
        NSLog("[gavin-shell] DeviceKeys: creating the Device's keys")
        guard Self.passcodeSet() else {
            reject(call, .noPasscode, "this phone has no passcode")
            return
        }
        if Self.stored() != nil {
            reject(call, .keysExist, "this phone already holds a Device's keys")
            return
        }
        // What a creation that did not finish left behind.
        Self.deleteAll()
        do {
            if Self.hardwareKeystore {
                try Self.createHardwareKey()
            } else if Self.softwareFallback {
                try Self.createSoftwareKey()
            } else {
                reject(call, .noHardwareKeystore, "this phone has no Secure Enclave")
                return
            }
            var noise = Data(count: 32)
            let random = noise.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
            guard random == errSecSuccess else { throw Self.keychainError("SecRandomCopyBytes", random) }
            try Self.addItem(service: Self.noiseService, data: noise)
            call.resolve(try Self.publicKeys())
        } catch {
            Self.deleteAll()
            reject(call, .failed, "the keys could not be made: \(error.localizedDescription)")
        }
    }

    @objc func deleteKeys(_ call: CAPPluginCall) {
        NSLog("[gavin-shell] DeviceKeys: deleting the Device's keys")
        hold(nil)
        Self.deleteAll()
        call.resolve()
    }

    static func createHardwareKey() throws {
        var error: Unmanaged<CFError>?
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: hardwareTag,
                kSecAttrAccessControl as String: try hardwareAccess(),
            ] as [String: Any],
        ]
        guard SecKeyCreateRandomKey(attributes as CFDictionary, &error) != nil else {
            throw error!.takeRetainedValue() as Error
        }
    }

    /// The hardware key's access control: usable for signing only once the
    /// owner has been asked -- biometry, falling back to the passcode
    /// (`.userPresence`; `.biometryCurrentSet` would destroy the Device at
    /// every new enrolment) -- and gone with the passcode.
    static func hardwareAccess() throws -> SecAccessControl {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .userPresence], &error
        ) else {
            throw error!.takeRetainedValue() as Error
        }
        return access
    }

    static func createSoftwareKey() throws {
        #if DEBUG
        try addItem(service: softwareService, data: P256.Signing.PrivateKey().rawRepresentation)
        #else
        throw keychainError("a software key in a release build", errSecUnimplemented)
        #endif
    }

    /// A generic-password item this device only: never synchronised, never
    /// restored to another phone, and gone if the passcode is removed.
    static func addItem(service: String, data: Data) throws {
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw keychainError("SecItemAdd(\(service))", status) }
    }

    /// The keys, and the Workstations paired with them: a record names
    /// the Device those keys made, and without them this phone is not it.
    static func deleteAll() {
        SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: hardwareTag] as CFDictionary)
        for service in [softwareService, noiseService] {
            SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
        }
        WorkstationsPlugin.deleteAll()
    }

    // MARK: reading

    /// A context that never shows anything: a lookup through it either
    /// works or fails.
    static func silentContext() -> LAContext {
        let context = LAContext()
        context.interactionNotAllowed = true
        return context
    }

    static func hardwareKey(through context: LAContext) -> (SecKey?, OSStatus) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: hardwareTag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
            kSecUseAuthenticationContext as String: context,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        // A CFTypeRef found under kSecClassKey is a SecKey.
        return (status == errSecSuccess ? (item as! SecKey) : nil, status)
    }

    static func itemData(service: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
            kSecUseAuthenticationContext as String: silentContext(),
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    /// Which hardware key this phone holds, when it holds the Noise key too.
    static func stored() -> Backing? {
        guard itemData(service: noiseService) != nil else { return nil }
        if hardwareKeyExists() { return .secureEnclave }
        if itemData(service: softwareService) != nil { return .softwareDebug }
        return nil
    }

    /// Whether the Secure Enclave key is there, asked without showing
    /// anything: a key that would need the owner even to be looked at
    /// answers "interaction not allowed", and that too means it is there.
    static func hardwareKeyExists() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: hardwareTag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnAttributes as String: true,
            kSecUseAuthenticationContext as String: silentContext(),
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    static func publicKeys() throws -> [String: Any] {
        let backing = stored()
        let point: Data
        switch backing {
        case .secureEnclave:
            var error: Unmanaged<CFError>?
            guard let key = hardwareKey(through: silentContext()).0,
                  let publicKey = SecKeyCopyPublicKey(key),
                  let raw = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?
            else {
                throw error.map { $0.takeRetainedValue() as Error } ?? keychainError("the public key", errSecItemNotFound)
            }
            point = raw
        case .softwareDebug:
            guard let raw = itemData(service: softwareService) else { throw keychainError("the software key", errSecItemNotFound) }
            point = try P256.Signing.PrivateKey(rawRepresentation: raw).publicKey.x963Representation
        case nil:
            throw keychainError("the keys", errSecItemNotFound)
        }
        // iOS offers no attestation for a key of our own (App Attest
        // attests only its own), so there the daemon has the shell's word.
        return ["hardwareKey": hex(point), "backing": backing!.rawValue, "attestation": [String]()]
    }

    @objc func publicKeys(_ call: CAPPluginCall) {
        guard Self.stored() != nil else {
            reject(call, .noKeys, "this phone holds no Device keys")
            return
        }
        do {
            call.resolve(try Self.publicKeys())
        } catch {
            reject(call, .failed, "the public keys could not be read: \(error.localizedDescription)")
        }
    }

    /// For the Companion core, in the shell's own web layer. Never a
    /// bundle's: no bundle can call this plugin.
    @objc func noiseKey(_ call: CAPPluginCall) {
        guard Self.stored() != nil, let raw = Self.itemData(service: Self.noiseService) else {
            reject(call, .noKeys, "this phone holds no Device keys")
            return
        }
        call.resolve(["privateKey": Self.hex(raw)])
    }

    // MARK: signing

    @objc func sign(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? ""
        NSLog("[gavin-shell] DeviceKeys: asked to sign for “%@”", reason)
        guard let hash = Self.bytes(hex: call.getString("handshakeHash") ?? ""), hash.count == Self.handshakeHashBytes else {
            reject(call, .badHash, "a handshake hash is \(Self.handshakeHashBytes) bytes of hex")
            return
        }
        guard !reason.isEmpty else {
            reject(call, .failed, "sign needs a reason to show the owner")
            return
        }
        guard let backing = Self.stored() else {
            reject(call, .noKeys, "this phone holds no Device keys")
            return
        }
        let message = Self.unlockContext + hash
        let context = LAContext()
        evaluate(context, backing: backing, reason: reason, call: call) {
            defer { context.invalidate() }
            // From here the context authorises the key without showing
            // anything more: the signature is made, or it fails.
            context.interactionNotAllowed = true
            do {
                let signature = try Self.signature(of: message, backing: backing, through: context)
                call.resolve(["signature": Self.hex(signature)])
            } catch {
                self.reject(call, .failed, "the key would not sign: \(error.localizedDescription)")
            }
        }
    }

    /// Asks for the owner through `context`, exactly as the key's own
    /// access control would, and runs `confirmed` once they are; a refusal
    /// rejects `call` in words.
    private func evaluate(_ context: LAContext, backing: Backing, reason: String, call: CAPPluginCall,
                          confirmed: @escaping () -> Void) {
        let evaluated: (Bool, Error?) -> Void = { ok, error in
            guard ok else {
                context.invalidate()
                let code = (error as? LAError)?.code
                switch code {
                case .userCancel?, .appCancel?, .systemCancel?:
                    self.reject(call, .cancelled, "the owner did not confirm")
                case .passcodeNotSet?:
                    self.reject(call, .noPasscode, "this phone has no passcode")
                default:
                    self.reject(call, .failed, "the owner could not be confirmed: \(error?.localizedDescription ?? "")")
                }
                return
            }
            confirmed()
        }
        switch backing {
        case .secureEnclave:
            do {
                // Exactly the key's own access control, for signing.
                context.evaluateAccessControl(try Self.hardwareAccess(), operation: .useKeySign,
                                              localizedReason: reason, reply: evaluated)
            } catch {
                context.invalidate()
                reject(call, .failed, "the key's access control: \(error.localizedDescription)")
            }
        case .softwareDebug:
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason, reply: evaluated)
        }
    }

    /// ECDSA over SHA-256 of `message`, ASN.1 DER: what the daemon verifies.
    static func signature(of message: Data, backing: Backing, through context: LAContext) throws -> Data {
        switch backing {
        case .secureEnclave:
            let (found, status) = hardwareKey(through: context)
            guard let key = found else { throw keychainError("the hardware key", status) }
            var error: Unmanaged<CFError>?
            guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) else {
                throw error!.takeRetainedValue() as Error
            }
            return signature as Data
        case .softwareDebug:
            #if DEBUG
            guard let raw = itemData(service: softwareService) else { throw keychainError("the software key", errSecItemNotFound) }
            return try P256.Signing.PrivateKey(rawRepresentation: raw).signature(for: message).derRepresentation
            #else
            throw keychainError("a software key in a release build", errSecUnimplemented)
            #endif
        }
    }

    // MARK: helpers

    func reject(_ call: CAPPluginCall, _ refusal: Refusal, _ message: String) {
        call.reject(message, refusal.rawValue)
    }

    static func keychainError(_ what: String, _ status: OSStatus) -> NSError {
        NSError(domain: NSOSStatusErrorDomain, code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "\(what): OSStatus \(status)"])
    }

    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    static func bytes(hex: String) -> Data? {
        guard hex.count % 2 == 0, hex.allSatisfy(\.isHexDigit) else { return nil }
        var out = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        return out
    }
}
