import type { AgentConfig } from "./gavin";
import { sha256Hex } from "./sha256";

/// Workspace trust for the three `.gavin-root/config.toml` keys that name
/// something gavin EXECUTES or WRITES as the user.
///
/// config.toml ships with the repository. `[agent] command` becomes the
/// launch shell command for Run and every rail step, above the profile
/// table; `[worktree] setup` lines are `&&`-chained ahead of the agent
/// when a worktree is cut; `[agent] file` names the file gavin writes its
/// integration block into and tells the agent to read. Everything else in
/// the file — the profile id, the model, the MCP dialect — selects a row
/// in gavin's own verified table, so a repo can only pick among things
/// gavin already trusts.
///
/// Those three are different in kind: their value is not a choice among
/// gavin's options, it IS the thing that runs. gavin's accepted design
/// trusts the configuration the human wrote and explicitly does not
/// accept "the same keys arriving from a repo the human just cloned" —
/// and until this module existed both arrived down one code path with no
/// provenance. A freshly cloned repo could hand its own command to a Run,
/// to a worktree, and (before the same fix in `superpowers.rs`) to a
/// passive tab render.
///
/// The marker is a digest of the three keys, stored per workspace in
/// config.json (`Workspace.trustedConfigHash`). It says: a human looked
/// at exactly these values and said yes. Any edit — the repo's, a
/// colleague's, a `git pull` — changes the digest and the keys go inert
/// again until somebody looks. gavin's own writers (Settings, the setup
/// wizard) re-stamp the marker in the same breath as the write, so the
/// human's own edits never trip the gate.
///
/// Machine-local on purpose. Trust is a statement by THIS person about
/// THIS checkout; shipping it in the repo would let the repo vouch for
/// itself, which is the whole thing being defended against.

/// The executable surface of one workspace's config.toml, normalised.
export interface ExecutionKeys {
  /// `[agent] command` — the launch shell command, "" when unset.
  command: string;
  /// `[agent] file` — the instructions file gavin writes and names, ""
  /// when unset.
  file: string;
  /// `[worktree] setup` — shell lines run in a new worktree, in file
  /// order, blanks dropped.
  setup: string[];
}

export const NO_EXECUTION_KEYS: ExecutionKeys = { command: "", file: "", setup: [] };

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/// The keys as they will actually be used: trimmed, blanks dropped —
/// exactly the normalisation `worktreeSetup.usable` and `settings.nonEmpty`
/// apply downstream. Hashing the raw text instead would make a re-indent
/// of config.toml revoke trust while changing nothing that runs, and
/// would let a value differ from the one the human was shown.
export function executionKeys(
  agent: AgentConfig | null | undefined,
  setup: readonly string[] | null | undefined
): ExecutionKeys {
  return {
    command: trimmed(agent?.command),
    file: trimmed(agent?.file),
    setup: (setup ?? []).map((line) => line.trim()).filter((line) => line.length > 0),
  };
}

/// Whether this config asks for any trust at all. A workspace that names
/// none of the three keys — every gavin workspace out of the box — has
/// nothing to approve and must never be asked: a consent prompt that
/// appears for everyone is one nobody reads.
export function hasExecutionKeys(keys: ExecutionKeys): boolean {
  return keys.command !== "" || keys.file !== "" || keys.setup.length > 0;
}

/// The marker for a set of keys, or "" when there is nothing to approve.
///
/// Over a JSON encoding rather than a joined string so no value can
/// impersonate the delimiter: a `setup` line containing the separator
/// would otherwise hash the same as two lines. Version-tagged so that
/// adding a fourth key later cannot silently collide with a marker
/// approved under the three.
export function executionKeysHash(keys: ExecutionKeys): string {
  if (!hasExecutionKeys(keys)) return "";
  return sha256Hex(
    `gavin-config-trust/1\n${JSON.stringify({
      command: keys.command,
      file: keys.file,
      setup: keys.setup,
    })}`
  );
}

/// Whether these keys are the ones the human approved.
///
/// Fails CLOSED in every uncertain case: an absent marker, a marker from
/// a different value, an empty string. The one true case that needs no
/// marker is a config that names nothing executable.
export function configTrusted(keys: ExecutionKeys, approvedHash: string | null | undefined): boolean {
  if (!hasExecutionKeys(keys)) return true;
  const approved = trimmed(approvedHash);
  return approved !== "" && approved === executionKeysHash(keys);
}

/// The `[agent]` block as the rest of the app may use it: the two
/// execution keys blanked out when the config is not approved, so
/// `resolveAgentConfig` falls back to the profile table's own verified
/// command and instructions file. Blanked rather than the whole config
/// dropped — `profile`, `model`, `mcpFile` and the rest stay, because a
/// repo choosing among gavin's rows is not the thing being gated.
///
/// Applied at the read, not at the launch, so no launch route can be
/// added later that forgets to ask.
export function trustedAgentConfig(
  agent: AgentConfig | null | undefined,
  trusted: boolean
): AgentConfig | null {
  if (!agent) return null;
  if (trusted) return agent;
  return { ...agent, command: null, file: null };
}

/// The declared worktree setup lines, or none when the config is not
/// approved. `setupPlan` then produces either the bare agent command or
/// null, exactly as it does for a workspace that declares no setup.
export function trustedSetup(setup: readonly string[] | null | undefined, trusted: boolean): string[] {
  return trusted ? [...(setup ?? [])] : [];
}

/// What the human is told, naming only the keys actually present. Written
/// as one sentence a person can act on rather than a security label:
/// the point is that something the repo wrote is being held back, and
/// that approving is a look-then-decide, not a dismissal.
export function configTrustNotice(keys: ExecutionKeys): string {
  const named: string[] = [];
  if (keys.command !== "") named.push("a launch command");
  if (keys.setup.length > 0) {
    named.push(keys.setup.length === 1 ? "a worktree setup command" : "worktree setup commands");
  }
  if (keys.file !== "") named.push("an instructions file");
  if (named.length === 0) return "";
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return `This repo's .gavin-root/config.toml names ${list} you have not approved. Until you do, gavin runs its own agent instead.`;
}

/// One row of the approval sheet: what the repo asks for, spelled out.
/// The VALUES, verbatim — a paraphrase is a second description to keep in
/// sync with the thing that actually runs, and this one cannot drift.
export interface TrustRow {
  key: string;
  value: string;
}

export function trustRows(keys: ExecutionKeys): TrustRow[] {
  const rows: TrustRow[] = [];
  if (keys.command !== "") rows.push({ key: "[agent] command", value: keys.command });
  if (keys.file !== "") rows.push({ key: "[agent] file", value: keys.file });
  for (const line of keys.setup) rows.push({ key: "[worktree] setup", value: line });
  return rows;
}
