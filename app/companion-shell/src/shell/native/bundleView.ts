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

/// One file of a bundle to install. `data` is base64.
export interface BundleFileToInstall {
  path: string;
  data: string;
}

export interface BundleViewPlugin {
  /// Opens a Workstation's bundle full-screen over the hub. `session`
  /// tags every event from this view; resolves with the bundle's origin.
  /// `bundle` names what the view serves at that origin: an embedded
  /// bundle (`demo`; `probe` in a debug build), or the hash of one
  /// `install` put in the cache.
  open(options: { session: number; workstation: string; bundle: string }): Promise<{ origin: string }>;
  /// Whether the cache holds a bundle by hash.
  installed(options: { hash: string }): Promise<{ installed: boolean }>;
  /// Puts a bundle's files in the cache under `hash`, whole or not at
  /// all: an install that fails leaves no bundle to serve.
  install(options: { hash: string; files: BundleFileToInstall[] }): Promise<void>;
  /// Removes every cached bundle whose hash is not in `keep`.
  prune(options: { keep: string[] }): Promise<void>;
  /// The public half of the dev bundle-signing key this build embeds,
  /// hex -- in a debug build. A release build answers null whatever it
  /// carries (ADR 0005: a store build refuses self-built bundles).
  devPublisherKey(): Promise<{ key: string | null }>;
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
