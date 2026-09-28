// The remote shim for `@tauri-apps/plugin-notification`.
//
// Notifications on a Device are the shell's: an encrypted push, decrypted
// natively, readable nowhere in between (spec "Notifications"). A bundle
// raising one of its own would be a second route to the same tray with
// none of that, so it is never granted the permission to.
//
// Nothing here is reached in practice -- the desktop asks whether its
// window is in front before it notifies, and the Companion's always is
// (window.ts). This is what stands behind that if it ever is not.
export type Permission = "granted" | "denied" | "default";

export interface Options {
  title: string;
  body?: string;
}

export async function isPermissionGranted(): Promise<boolean> {
  return false;
}

export async function requestPermission(): Promise<Permission> {
  return "denied";
}

export function sendNotification(_options: Options | string): void {}
