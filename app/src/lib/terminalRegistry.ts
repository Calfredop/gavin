import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "./backend";

interface RegistryEntry {
  term: Terminal;
  container: HTMLDivElement;
  fitAddon: FitAddon;
}

const registry = new Map<string, RegistryEntry>();
const pendingUnlisten = new Map<string, () => void>();

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

  const term = new Terminal({ convertEol: false });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
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
}
