import { describe, it, expect } from "vitest";

// Commands that must not run on the main thread.
//
// Tauri gives a plain `fn` command a blocking execution context: it runs
// inline on the thread that draws the window and takes its input. So a
// command that waits on a child process or the network freezes the whole
// app for as long as it waits -- the cursor spins, typing into a terminal
// stalls and replays afterwards -- while every suite stays green, because
// nothing here runs under Tauri. Measured 2026-09-26: `pr_status`'s `gh`
// round trips held the main thread 12 s of every minute, in unbroken runs
// of up to 9.5 s, and `git_run_changes` about a second per call.
//
// Each one listed is `async` and hands its work to the blocking pool, the
// shape `get_git_baselines` documents. The list is not exhaustive: it is
// the commands measured or known to wait on something slow, so none of
// them can quietly go back to a plain `fn`.

const RUST = import.meta.glob("../../../src-tauri/src/**/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function rust(file: string): string {
  const found = Object.entries(RUST).find(([path]) => path.endsWith(`/${file}`));
  if (!found) throw new Error(`${file} not found`);
  return found[1];
}

/// [file under src-tauri/src, command, what it waits on]
const OFF_MAIN_THREAD: [file: string, command: string, waitsOn: string][] = [
  ["pull_request.rs", "pr_status", "`gh`, a GitHub round trip"],
  ["git/runchanges.rs", "git_run_changes", "several `git` processes"],
  ["git/commands.rs", "get_git_baselines", "`git status` per session, on the load path"],
  ["typesafe.rs", "typesafe_verdict", "an HTTPS request"],
  ["typesafe.rs", "typesafe_attribution", "an HTTPS request"],
];

/// The command's text from its `#[tauri::command]` line to the first
/// line that closes a top-level item.
function commandBody(file: string, command: string): string {
  const text = rust(file);
  const at = text.search(new RegExp(`#\\[tauri::command\\]\\s*pub (async )?fn ${command}\\(`));
  expect(at, `${command} is not a command in ${file}`).toBeGreaterThan(-1);
  return text.slice(at, text.indexOf("\n}\n", at));
}

describe("commands that wait on something slow", () => {
  for (const [file, command, waitsOn] of OFF_MAIN_THREAD) {
    it(`${command} (${waitsOn}) runs off the main thread`, () => {
      const body = commandBody(file, command);
      expect(body).toContain(`pub async fn ${command}(`);
      expect(body).toContain("spawn_blocking");
    });
  }
});
