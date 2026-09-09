import type { ForeignMcpServer, IntegrationResult } from "./backend";
import * as backend from "./backend";
import { sha256Hex } from "./sha256";

/// The AG-07 gate: whether a workspace's target MCP config file already
/// names servers gavin did not add, and what the human said about them.
///
/// `setupAgentIntegration` used to merge its own `gavin` entry into
/// whatever `.mcp.json` (or `.codex/config.toml`, `.gemini/settings.json`,
/// `opencode.json`) the repo already shipped, preserving every other
/// server key with no word to the human. A cloned repo could ship a
/// hostile server beside a legitimate one, and the agent CLI would
/// launch it. This module is the client half of the fix: it hashes the
/// foreign SET the daemon-adjacent host command found, so the human's
/// answer -- "keep" or "isolate" -- can be recorded once and replayed for
/// exactly that set (`Workspace.mcpForeignServersChoice`), the same
/// shape `workspaceTrust.ts` uses for the `.gavin-root/config.toml`
/// execution keys.
///
/// Deliberately keyed on the SERVERS, not the file they came from: the
/// question this gate asks is "do you know about these servers", and a
/// workspace root that moves on disk, or a profile that happens to point
/// at a file with the identical foreign set, changes nothing about that
/// answer.

export interface McpForeignChoice {
  hash: string;
  action: "keep" | "isolate";
}

/// Normalises the set the same way a re-scan would produce it, so a
/// re-ordering that changes nothing about what would launch does not
/// change the digest. The host already returns them name-sorted; this
/// is the same normalisation applied defensively, on the client's own
/// terms, rather than trusted from the wire.
function normalised(servers: readonly ForeignMcpServer[]): ForeignMcpServer[] {
  return [...servers].sort((a, b) => a.name.localeCompare(b.name));
}

/// The digest of a foreign-server set, "" when there is nothing to
/// approve. Over a JSON encoding and version-tagged for the same reason
/// `executionKeysHash` is: no server's name, command or arg can
/// impersonate a delimiter, and a later change to what this hashes
/// cannot silently collide with a marker approved under the old shape.
export function foreignMcpServersHash(servers: readonly ForeignMcpServer[]): string {
  if (servers.length === 0) return "";
  return sha256Hex(`gavin-mcp-trust/1\n${JSON.stringify(normalised(servers))}`);
}

/// The recorded action, if `choice` is for exactly this set; `undefined`
/// otherwise -- no servers to decide on, no choice recorded yet, or one
/// recorded for a set that has since changed (an edited `mcp_file`, a
/// `git pull`, a colleague's edit to the target file). `undefined` is
/// what a caller re-asks on, so a decision nobody was shown this exact
/// set is never replayed.
export function mcpForeignDecision(
  servers: readonly ForeignMcpServer[],
  choice: McpForeignChoice | null | undefined
): "keep" | "isolate" | undefined {
  if (servers.length === 0 || !choice) return undefined;
  return choice.hash === foreignMcpServersHash(servers) ? choice.action : undefined;
}

/// What the human is told before answering, naming the count so a
/// one-line banner reads correctly for one server or several.
export function mcpForeignNotice(servers: readonly ForeignMcpServer[]): string {
  if (servers.length === 0) return "";
  const noun = servers.length === 1 ? "a server" : `${servers.length} servers`;
  return `This file already runs ${noun} gavin did not add.`;
}

/// Runs `setupAgentIntegration`, resolving the gate from `storedChoice`
/// when it already answers the set the host reports back. A first call
/// with no choice is unavoidable either way -- reading the target file
/// is the host's job, not something the frontend can know in advance --
/// so this makes that first call always, and only spends a second one
/// when a recorded decision actually applies. When it does not (nothing
/// recorded, or the set changed), the MCP write stays held back and the
/// result's `mcpForeign` is what the caller shows a chooser for; call
/// `setupAgentIntegration` again with the human's pick once they answer.
export async function runIntegration(
  rootPath: string,
  instructionsFile: string,
  storedChoice: McpForeignChoice | null | undefined
): Promise<IntegrationResult> {
  const first = await backend.setupAgentIntegration(rootPath, instructionsFile);
  if (!first.mcpForeign) return first;
  const decided = mcpForeignDecision(first.mcpForeign.servers, storedChoice);
  return decided ? backend.setupAgentIntegration(rootPath, instructionsFile, decided) : first;
}
