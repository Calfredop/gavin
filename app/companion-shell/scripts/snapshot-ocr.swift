// OCR helper for scripts/snapshot.sh: prints every recognised string in
// the image (one per line). Uses Vision on macOS; no extra tools.
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
    fputs("usage: snapshot-ocr <image>\n", stderr)
    exit(2)
}
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cg = bitmap.cgImage else {
    fputs("could not read image: \(path)\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([request])
for observation in request.results ?? [] {
    if let text = observation.topCandidates(1).first?.string, !text.isEmpty {
        print(text)
    }
}
