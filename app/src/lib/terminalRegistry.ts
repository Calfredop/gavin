import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import * as backend from "./backend";
import { isViewableInApp } from "./fileTypes";
import { xtermTheme } from "./ui/terminalTheme";
import type { EffectiveTheme } from "./ui/theme";

interface RegistryEntry {
  term: Terminal;
  container: HTMLDivElement;
  fitAddon: FitAddon;
}

const registry = new Map<string, RegistryEntry>();
const pendingUnlisten = new Map<string, () => void>();

// The session's own live cwd, mirrored here from layoutState's
// cwdBySessionId (kept current by the existing OSC 7 plumbing) via
// setCwdForLinks below. A local mirror rather than reading the store
// directly for two reasons: provideLinks is called synchronously per
// rendered line and cannot await, and this module must never statically
// import layoutState.ts, which already imports THIS module (a static
// import back would be circular).
const cwdBySessionId = new Map<string, string>();

function cwdForSession(sessionId: string): string {
  return cwdBySessionId.get(sessionId) ?? "";
}

export function setCwdForLinks(sessionId: string, cwd: string): void {
  cwdBySessionId.set(sessionId, cwd);
}

// Matches path-shaped runs of text in a rendered line: absolute (/...),
// home-relative (~/...), or relative containing a slash. Deliberately
// stricter than "any word" -- every candidate costs a resolve round-trip
// on hover, and a false positive that resolves to nothing just never
// becomes clickable anyway.
const PATH_CANDIDATE = /(~\/|\.{0,2}\/)[^\s'"()[\]{}:,]+/g;

async function activatePath(resolvedPath: string, sessionId: string): Promise<void> {
  if (await isViewableInApp(resolvedPath)) {
    const { openFileInSplit } = await import("./layoutState");
    await openFileInSplit(sessionId, resolvedPath);
    return;
  }
  // No error UI reaches a terminal pane, but log rather than swallow --
  // a silent no-op here is indistinguishable from "the click didn't
  // register," which is how the missing opener:allow-open-path
  // capability originally presented.
  await openPath(resolvedPath).catch((e) => {
    console.error(`failed to open ${resolvedPath} externally:`, e);
  });
}

function registerPathLinks(term: Terminal, sessionId: string): void {
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const cwd = cwdForSession(sessionId);
      const matches = [...text.matchAll(PATH_CANDIDATE)];
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      void Promise.all(
        matches.map(async (m) => {
          const candidate = m[0];
          const resolved = await backend.resolvePathUnderCursor(candidate, cwd).catch(() => null);
          if (!resolved) return null;
          const start = (m.index ?? 0) + 1;
          return {
            range: {
              start: { x: start, y: lineNumber },
              end: { x: start + candidate.length - 1, y: lineNumber },
            },
            text: candidate,
            activate: (event: MouseEvent) => {
              // Cmd+click only -- a plain click must keep doing exactly
              // what it does today (nothing special).
              if (!event.metaKey) return;
              void activatePath(resolved, sessionId);
            },
          };
        })
      ).then((links) => {
        const real = links.filter((l): l is NonNullable<typeof l> => l !== null);
        callback(real.length > 0 ? real : undefined);
      });
    },
  });
}

// Returns the persistent terminal for a session, creating it (and wiring
// its input/output plumbing) exactly once on first access. Reusing the
// same Terminal/container across remounts is what lets a session survive a
// tree SHAPE change elsewhere (e.g. splitting a sibling pane, which changes
// this pane's position in the component tree and would otherwise destroy
// and recreate everything below it) without losing scrollback or needing a
// new Attach. The container is a detached div until some TerminalPane
// appends it into its own mount point.
export function getOrCreateTerminal(sessionId: string): RegistryEntry {
  const existing = registry.get(sessionId);
  if (existing) return existing;

  const term = new Terminal({ convertEol: false, theme: xtermTheme(currentTheme) });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      // Cmd+click only, matching the path links -- a plain click on a URL
      // keeps doing nothing, as it does today.
      if (!event.metaKey) return;
      void openUrl(uri).catch(() => {});
    })
  );
  registerPathLinks(term, sessionId);
  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";
  term.open(container);

  term.onData((data) => {
    backend.writeInput(sessionId, data).catch(() => {});
  });

  let unlisten: UnlistenFn | undefined;
  listen<[string, string]>("pty-output", (event) => {
    const [id, data] = event.payload;
    if (id !== sessionId) return;
    term.write(data);
  }).then((fn) => {
    unlisten = fn;
  });
  pendingUnlisten.set(sessionId, () => unlisten?.());

  const entry: RegistryEntry = { term, container, fitAddon };
  registry.set(sessionId, entry);
  return entry;
}

/// Terminals outlive the components that show them (see
/// getOrCreateTerminal), so a theme flip has to reach every terminal
/// already in the registry -- not just ones created afterwards. Held at
/// module level so newly created terminals start in the right theme too.
let currentTheme: EffectiveTheme = "dark";

export function applyTerminalTheme(theme: EffectiveTheme): void {
  currentTheme = theme;
  const next = xtermTheme(theme);
  for (const entry of registry.values()) {
    entry.term.options.theme = next;
  }
}

export function getTerminal(sessionId: string): Terminal | undefined {
  return registry.get(sessionId)?.term;
}

// Called only when a session is genuinely gone (killed or exited) -- never
// on an ordinary tab-switch or tree-shape remount, which just re-parent the
// existing entry instead of destroying it. Wired from layoutState.ts.
export function destroyTerminal(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  pendingUnlisten.get(sessionId)?.();
  pendingUnlisten.delete(sessionId);
  entry.term.dispose();
  registry.delete(sessionId);
  cwdBySessionId.delete(sessionId);
}
