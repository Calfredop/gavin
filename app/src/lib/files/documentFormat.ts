// Cheap, safe document formatters for Edit mode. Pure over (path, text):
// no CodeMirror, no Prettier, no project tooling. Only languages where the
// transform is tiny and cannot invent semantics belong here — today that
// is JSON pretty-print. Anything heavier stays out of the bundle.

import { fileExtension } from "$lib/files/fileTypes";

export type FormatDocumentResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/// True when Format is on offer for this path. The FileEditor button and
/// the editor chord both read this, so a language we cannot format never
/// shows a control that no-ops. Kept off codeMirror.ts so this module
/// stays free of a cycle (createEditor calls formatDocument).
export function canFormatDocument(path: string): boolean {
  return fileExtension(path) === "json";
}

/// Pretty-print JSON with 2-space indent. Preserves a trailing newline when
/// the input had one, so a save does not thrash "file ends with newline"
/// diffs. Invalid JSON is refused, never half-rewritten.
export function formatDocument(path: string, text: string): FormatDocumentResult {
  if (!canFormatDocument(path)) {
    return { ok: false, reason: "No formatter for this file type." };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: true, text };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `Invalid JSON: ${message}` };
  }
  const pretty = JSON.stringify(value, null, 2);
  const trailingNewline = text.endsWith("\n") || text.endsWith("\r\n");
  return { ok: true, text: trailingNewline ? `${pretty}\n` : pretty };
}
