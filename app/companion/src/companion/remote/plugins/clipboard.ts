// The remote shim for `@tauri-apps/plugin-clipboard-manager`.
//
// Copying is something the page can do for itself, with the web
// platform's own clipboard -- the Device's, which is the one the human
// is holding. It asks nothing of the shell and nothing of the desk.
function asTauriRejects(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pageClipboard(): Clipboard | null {
  return typeof navigator === "undefined" ? null : (navigator.clipboard ?? null);
}

export async function writeText(text: string): Promise<void> {
  const clipboard = pageClipboard();
  if (!clipboard?.writeText) throw "this Companion has no clipboard to write to";
  try {
    await clipboard.writeText(text);
  } catch (e) {
    throw asTauriRejects(e);
  }
}

export async function readText(): Promise<string> {
  const clipboard = pageClipboard();
  if (!clipboard?.readText) throw "this Companion has no clipboard to read from";
  try {
    return await clipboard.readText();
  } catch (e) {
    throw asTauriRejects(e);
  }
}
