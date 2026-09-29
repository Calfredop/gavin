import AVFoundation
import Capacitor
import UIKit

/// The camera, for one thing: reading the pairing QR the desk shows
/// (`src/shell/native/qrScanner.ts`).
///
/// Registered on the shell's own Capacitor webview only. It shows a
/// full-screen scanner of its own over the app, and hands back the first
/// QR code it reads and nothing else: no frame, no picture, no other kind
/// of code.
///
/// A Simulator has no camera. A debug build launched with
/// `-GavinPairCode <base64>` (scripts/pair.sh) answers `scriptedCode` with
/// that code instead, and the hub pairs with it as with one it scanned.
@objc(QrScannerPlugin)
public class QrScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QrScannerPlugin"
    public let jsName = "QrScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scriptedCode", returnType: CAPPluginReturnPromise),
    ]

    @objc func scan(_ call: CAPPluginCall) {
        guard AVCaptureDevice.default(for: .video) != nil else {
            call.reject("this phone has no camera", "no-camera")
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            present(call)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted {
                        self.present(call)
                    } else {
                        call.reject("the camera was not allowed", "camera-denied")
                    }
                }
            }
        default:
            call.reject("the camera is not allowed", "camera-denied")
        }
    }

    private func present(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("there is nothing to show the scanner over", "failed")
                return
            }
            let scanner = QrScanViewController { outcome in
                switch outcome {
                case .code(let text):
                    call.resolve(["text": text])
                case .cancelled:
                    call.reject("the scanner was closed", "cancelled")
                case .failed(let why):
                    call.reject(why, "failed")
                }
            }
            scanner.modalPresentationStyle = .fullScreen
            host.present(scanner, animated: true)
        }
    }

    @objc func scriptedCode(_ call: CAPPluginCall) {
        #if DEBUG
        if let encoded = UserDefaults.standard.string(forKey: "GavinPairCode"),
           let data = Data(base64Encoded: encoded),
           let text = String(data: data, encoding: .utf8) {
            call.resolve(["text": text])
            return
        }
        #endif
        call.resolve(["text": NSNull()])
    }
}

/// The scanner: the camera's picture, full screen, with a line saying
/// what to point it at and a way out.
final class QrScanViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    enum Outcome {
        case code(String)
        case cancelled
        case failed(String)
    }

    private let session = AVCaptureSession()
    private let finish: (Outcome) -> Void
    private var finished = false
    private var preview: AVCaptureVideoPreviewLayer?
    /// Why the camera could not be set up, said once the scanner is on
    /// screen: dismissing it while it is still being presented would not.
    private var setupFailure: String?

    init(finish: @escaping (Outcome) -> Void) {
        self.finish = finish
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("not made from a storyboard")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            setupFailure = "the camera could not be opened"
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            setupFailure = "the camera cannot read codes"
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview

        let hint = UILabel()
        hint.text = "Point the camera at the code in Gavin’s Devices panel at your desk."
        hint.textColor = .white
        hint.font = .preferredFont(forTextStyle: .body)
        hint.numberOfLines = 0
        hint.textAlignment = .center
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)

        var cancelStyle = UIButton.Configuration.filled()
        cancelStyle.title = "Cancel"
        cancelStyle.baseBackgroundColor = UIColor(white: 0.15, alpha: 0.9)
        cancelStyle.baseForegroundColor = .white
        cancelStyle.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 24, bottom: 12, trailing: 24)
        let cancel = UIButton(configuration: cancelStyle, primaryAction: UIAction { [weak self] _ in
            self?.end(.cancelled)
        })
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancel)

        NSLayoutConstraint.activate([
            hint.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            hint.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])

        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let why = setupFailure { end(.failed(why)) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let code = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else {
            return
        }
        end(.code(code))
    }

    private func end(_ outcome: Outcome) {
        guard !finished else { return }
        finished = true
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        let finish = self.finish
        dismiss(animated: true) { finish(outcome) }
    }
}
