// The shell's one native plugin: the bundle webview.
//
// Only the shell's own web layer -- the hub, shipped in the binary -- can
// call it. The bundle it opens runs in a separate webview that has no
// Capacitor bridge at all, so nothing here is reachable from a bundle;
// the bundle's messages arrive as `message` events, already checked
// natively for frame and origin, and go back through `post`.
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/// A message the bundle posted on its channel. `origin` is the one the
/// native side saw it come from.
export interface BundleMessageEvent {
  session: number;
  origin: string;
  data: string;
}

/// A message the native side refused: another origin, or not the
/// bundle's main frame. Only where it came from -- never what it said.
export interface BundleDroppedEvent {
  session: number;
  origin: string;
  mainFrame: boolean;
}

/// The view closed without the hub asking: the system's back gesture.
export interface BundleClosedEvent {
  session: number;
}

export interface BundleViewPlugin {
  /// Opens a Workstation's bundle full-screen over the hub. `session`
  /// tags every event from this view; resolves with the bundle's origin.
  open(options: { session: number; workstation: string }): Promise<{ origin: string }>;
  /// Hands a message to the bundle's main frame, if `session` is still
  /// the open view.
  post(options: { session: number; data: string }): Promise<void>;
  close(options: { session: number }): Promise<void>;
  /// Opens an http(s) link in the system browser.
  openExternal(options: { url: string }): Promise<void>;
  /// Whether this debug build was launched to run the bundle probe.
  /// Always false in a release build.
  probeRequested(): Promise<{ probe: boolean }>;
  addListener(event: "message", listener: (e: BundleMessageEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "dropped", listener: (e: BundleDroppedEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "closed", listener: (e: BundleClosedEvent) => void): Promise<PluginListenerHandle>;
}

export const BundleView = registerPlugin<BundleViewPlugin>("BundleView");
