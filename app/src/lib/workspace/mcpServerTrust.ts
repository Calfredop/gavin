import { get, writable } from "svelte/store";
import type { ForeignMcpServer, IntegrationResult } from "$lib/core/backend";
import * as backend from "$lib/core/backend";
import { askConfirm } from "$lib/core/dialog";
import { mcpForeignDecision, type McpForeignChoice } from "$lib/workspace/mcpForeignChoice";

/// Per-project-root cache of the last foreign-server scan. Keyed by the
/// launch cwd Cursor treats as `projectRoot` (cwd, not necessarily the
/// workspace root — a rail worktree has its own `.cursor/mcp.json`).
/// A missing key means "not scanned yet"; an empty array means scanned
/// and nothing foreign. A store so "Launches as" and the commit blocker
/// update when a scan lands.
export const foreignMcpScanStore = writable<Record<string, ForeignMcpServer[]>>({});

export {
  cursorMcpApproval,
  foreignMcpServersHash,
  mcpForeignDecision,
  type McpForeignChoice,
} from "$lib/workspace/mcpForeignChoice";

/// Why a hidden Cursor run is refused while the foreign-server disclosure
/// is unresolved. Named once so the Git tab blocker, the commit launch
/// path and any other headless gate stay on the same sentence.
export const CURSOR_MCP_HEADLESS_BLOCKER =
  "Answer the MCP server disclosure for this workspace before a hidden Cursor run";

/// Why an unattended Cursor launch (queued intent, rail step, auto-resume)
/// is refused while the disclosure is unresolved. A dialog in a tab
/// nobody watches is a silent stall — the same posture
/// `UNREVIEWED_UNATTENDED` takes for the review gate.
export const CURSOR_MCP_UNATTENDED_BLOCKER =
  "Answer the MCP server disclosure for this workspace before an unattended Cursor run";

/// One-line reason a visible Cursor launch is withholding `--approve-mcps`,
/// so the human knows why Cursor's own approval dialog will appear.
export const CURSOR_MCP_DIALOG_NOTICE =
  "This workspace has MCP servers gavin did not add that you have not kept — Cursor will ask before loading them.";

/// The cached foreign set for `rootPath`, or `undefined` when nothing has
/// been scanned there yet.
export function cachedForeignMcpServers(rootPath: string): ForeignMcpServer[] | undefined {
  const entry = get(foreignMcpScanStore)[rootPath];
  return entry;
}

/// Refresh the foreign-server scan for the project root a Cursor launch
/// will use as cwd. Returns the set and stores it for sync resolve.
export async function refreshForeignMcpServers(
  rootPath: string,
  profileId?: string
): Promise<ForeignMcpServer[]> {
  const servers = await backend.scanForeignMcpServers(rootPath, profileId);
  foreignMcpScanStore.update((m) => ({ ...m, [rootPath]: servers }));
  return servers;
}

/// Seed the cache from an Integration result that already scanned, so a
/// Keep/Isolate answer and the next launch see the same set without a
/// second round trip.
export function rememberForeignMcpServers(
  rootPath: string,
  servers: readonly ForeignMcpServer[]
): void {
  foreignMcpScanStore.update((m) => ({ ...m, [rootPath]: [...servers] }));
}

/// Input for `resolveAgentConfig`'s Cursor composition, or `undefined`
/// when the root has not been scanned yet (withhold by default).
export function cursorMcpInputFor(
  rootPath: string | null | undefined,
  choice: McpForeignChoice | null | undefined,
  scans: Record<string, ForeignMcpServer[]> = get(foreignMcpScanStore)
): { servers: readonly ForeignMcpServer[]; choice: McpForeignChoice | null | undefined } | undefined {
  if (!rootPath) return undefined;
  const servers = scans[rootPath];
  if (servers === undefined) return undefined;
  return { servers, choice };
}

/// What the human is told before answering, naming the count so a
/// one-line banner reads correctly for one server or several.
export function mcpForeignNotice(servers: readonly ForeignMcpServer[]): string {
  if (servers.length === 0) return "";
  const noun = servers.length === 1 ? "a server" : `${servers.length} servers`;
  return `This file already runs ${noun} gavin did not add.`;
}

/// The one-line summary the Settings panel shows after a setup run.
///
/// Lives here rather than in the component for the usual reason -- a
/// template cannot be unit-tested and this string is the whole of what
/// the human is told. `replaced` gets its own clause instead of folding
/// into `written`: a setup run put a stale embedded template back over a
/// skill this workspace had edited, with no prompt and nothing on
/// screen, in a checkout several people share, and the obvious reading
/// of the diff was that an agent had done it. The bytes are preserved
/// now; this clause is the half that says so.
/// `rootPath` is optional and paths stay absolute without one, matching
/// the wizard's own `short`: a workspace with no root cannot have been
/// set up, and trimming against `""` would eat the leading separator of
/// every path instead.
export function integrationNote(
  result: IntegrationResult,
  rootPath: string | undefined
): string {
  const short = (f: string): string => (rootPath ? f.replace(rootPath + "/", "") : f);
  const clauses = [`Wrote: ${result.written.map(short).join(", ")}`];
  for (const [file, backup] of result.replaced) {
    clauses.push(`Replaced ${short(file)}, keeping your copy as ${short(backup)}`);
  }
  if (result.skipped.length > 0) {
    clauses.push(`Skipped: ${result.skipped.map(([what]) => what).join(", ")}`);
  }
  return `${clauses.join(". ")} — re-run any time to update.`;
}

/// Asks whether to trust a `checkoutMarkOffer`, and re-runs Integration
/// with the mark when the human approves. Declining leaves the absolute
/// binary already on disk and strips the offer from the result.
export async function resolveCheckoutMarkOffer(
  result: IntegrationResult,
  rootPath: string,
  instructionsFile: string,
  mcpForeignChoice?: "keep" | "isolate",
  profileId?: string
): Promise<IntegrationResult> {
  if (!result.checkoutMarkOffer) return result;
  const ok = await askConfirm({
    title: `Trust ${result.checkoutMarkOffer.launcher}?`,
    lines: [
      "This root ships a gavin-mcp launcher. Approving lets this repository choose what gavin's MCP entry runs.",
      "Declining keeps the absolute gavin-mcp beside the app.",
    ],
    confirmLabel: "Trust launcher",
  });
  if (!ok) {
    const { checkoutMarkOffer: _, ...rest } = result;
    return rest;
  }
  return backend.setupAgentIntegration(
    rootPath,
    instructionsFile,
    mcpForeignChoice,
    profileId,
    true
  );
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
///
/// When the host offers a checkout mark (`checkoutMarkOffer`), asks with
/// `askConfirm` whether to trust the repository's launcher. Approving
/// re-runs with the mark recorded so gavin's entry names that launcher;
/// declining leaves the absolute binary already written.
export async function runIntegration(
  rootPath: string,
  instructionsFile: string,
  storedChoice: McpForeignChoice | null | undefined,
  profileId?: string
): Promise<IntegrationResult> {
  const first = await backend.setupAgentIntegration(rootPath, instructionsFile, undefined, profileId);
  if (!first.mcpForeign) {
    return resolveCheckoutMarkOffer(first, rootPath, instructionsFile, undefined, profileId);
  }
  const decided = mcpForeignDecision(first.mcpForeign.servers, storedChoice);
  if (!decided) return first;
  const after = await backend.setupAgentIntegration(rootPath, instructionsFile, decided, profileId);
  return resolveCheckoutMarkOffer(after, rootPath, instructionsFile, decided, profileId);
}
