import type { Terminal } from "@xterm/xterm";

const registry = new Map<string, Terminal>();

export function registerTerminal(sessionId: string, term: Terminal): void {
  registry.set(sessionId, term);
}

export function unregisterTerminal(sessionId: string): void {
  registry.delete(sessionId);
}

export function getTerminal(sessionId: string): Terminal | undefined {
  return registry.get(sessionId);
}
