/// When the setup wizard asks the human where `npx` is. The search itself
/// is Rust's (`app/src-tauri/src/npx.rs`): PATH, the usual Node.js install
/// places, the login shell. This module decides when that search has
/// failed for good -- the only time the manual path is offered -- and
/// checks what the human typed before it crosses.

/// The start of the host's "there is no npx" message (`npx::NOT_FOUND`).
/// Matched as a prefix-anywhere, never as the whole sentence, so the
/// explanation after it can change without the prompt going quiet.
export const NPX_NOT_FOUND = "npx was not found";

/// What the host knows about `npx` on this machine.
export interface NpxReport {
  /// Where gavin found it, by whatever route; null when nowhere.
  found: string | null;
  /// The path the human gave, if they gave one.
  manual: string | null;
}

/// Whether an install's error is the final "no npx anywhere".
export function isNpxNotFound(error: string | null | undefined): boolean {
  return Boolean(error?.includes(NPX_NOT_FOUND));
}

/// Whether Playwright's checks say THIS machine has no `npx`. Never for an
/// ssh workspace: its `npx` is the host's, and a path on this machine
/// would answer nothing there.
export function playwrightLacksLocalNpx(
  checks: readonly { id: string; ok: boolean | null }[],
  ssh: boolean
): boolean {
  return !ssh && checks.some((c) => c.id === "npx" && c.ok === false);
}

/// Why `input` cannot be the path to `npx`, or null when it can be sent.
/// Only what can be told without the disk: the host checks the file
/// exists and answers `--version`.
export function npxPathProblem(input: string): string | null {
  const path = input.trim();
  if (!path) return "Paste the path to npx.";
  const absolute = path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(path);
  if (!absolute) return "That is not a full path — it should start with / (or C:\\ on Windows).";
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!["npx", "npx.cmd", "npx.exe"].includes(name)) {
    return "That path does not end in npx.";
  }
  return null;
}

/// The command that prints the path, for the human's own terminal.
export function whereCommand(windows: boolean): string {
  return windows ? "where npx" : "command -v npx";
}
