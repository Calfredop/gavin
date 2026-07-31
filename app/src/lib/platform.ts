import { platform } from "@tauri-apps/plugin-os";

export async function isMacOS(): Promise<boolean> {
  return (await platform()) === "macos";
}
