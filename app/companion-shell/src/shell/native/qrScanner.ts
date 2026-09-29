// The shell's camera, for one thing: reading the pairing QR at the desk.
//
// Registered on the shell's own bridge only. On iOS it is the shell's own
// AVFoundation scanner; on Android, Google's code scanner, which asks for
// no camera permission because Google Play services runs the camera and
// hands back only the code.
//
// A Simulator has no camera. A debug build launched by `scripts/pair.sh`
// is handed the code instead (`scriptedCode`), and pairs with it exactly
// as with one it scanned.
import { registerPlugin } from "@capacitor/core";

export type ScanErrorCode =
  /// The owner closed the scanner.
  | "cancelled"
  | "no-camera"
  /// The owner has not let Gavin use the camera.
  | "camera-denied"
  | "failed";

export interface QrScannerPlugin {
  /// Opens the scanner over the app and resolves with the first QR code it
  /// reads.
  scan(): Promise<{ text: string }>;
  /// The code a script launched this debug build with; null in any other
  /// build, and when there was none.
  scriptedCode(): Promise<{ text: string | null }>;
}

export const QrScanner = registerPlugin<QrScannerPlugin>("QrScanner");
