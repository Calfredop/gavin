// Push on this phone (companion-25; ios/App/App/PushPlugin.swift).
//
// Registered on the shell's own bridge only, like the Device's keys: a
// bundle's webview has no bridge, so no bundle can ask to notify, read the
// push token, or reach the Push gateway as this phone.
//
// - **iOS**: asks to notify, registers with APNs for the token, calls the
//   Push gateway natively (the gateway answers no CORS, and the hub's page
//   is another origin), keeps the gateway registration in the keychain, and
//   reports a tapped notification as `opened`. What a push says is opened by
//   the Notification Service Extension, never here.
// - **Android**: not yet (FCM). Every call rejects as unimplemented, and the
//   hub shows no Notifications row.
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type PushPermission = "prompt" | "granted" | "denied" | "provisional" | "ephemeral";

export type ApsEnvironment = "development" | "production";

export interface PushStatus {
  permission: PushPermission;
  /// The Push gateway this build registers with; absent when it names none.
  gateway?: string;
  /// Which APNs this install's tokens come from.
  environment: ApsEnvironment;
}

export type PushRegistered =
  | { permission: "granted"; token: string; environment: ApsEnvironment }
  | { permission: Exclude<PushPermission, "granted"> };

/// A notification the owner tapped: where it lands (`deepLinkFor`), and
/// the Workstation and item it was about when a key opened it.
export interface PushTap {
  link: string;
  workstation?: string;
  item?: string;
}

export interface GatewayRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /// Under `/v1/`.
  path: string;
  bearer?: string;
  /// JSON.
  body?: string;
}

export interface GatewayAnswer {
  status: number;
  body: string;
}

export interface PushPlugin {
  status(): Promise<PushStatus>;
  /// Asks to notify -- iOS asks the owner only the first time -- and once
  /// allowed, answers with this install's token.
  register(): Promise<PushRegistered>;
  gateway(request: GatewayRequest): Promise<GatewayAnswer>;
  /// This install's registration with the gateway, as `push/registration.ts`
  /// keeps it.
  registration(): Promise<{ record: string | null }>;
  /// Replaces it; without `record`, forgets it.
  keepRegistration(options: { record?: string }): Promise<void>;
  /// Clears one Workstation's notifications from the screen: every one
  /// whose item is not in `keep`, or all of them without it.
  clearDelivered(options: { workstation: string; keep?: string[] }): Promise<void>;
  addListener(event: "opened", listener: (tap: PushTap) => void): Promise<PluginListenerHandle>;
}

export const Push = registerPlugin<PushPlugin>("Push");
