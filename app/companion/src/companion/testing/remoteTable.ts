// The Remote role's command table as the daemon enforces it
// (`protocol::remote_command_table`), read from its source, so a suite
// can hold what a surface sends to what a real Workstation lets a Device
// send. The Demo Workstation's own gate (remoteRole.ts) refuses only the
// part of the table the bundle knew about when it was written; this is
// the whole of it.
import table from "../../../../../crates/protocol/src/remote_commands.rs?raw";

const ENTRY = /\("([a-z_]+)",\s*RemoteAllowance::(Allowed|Refused)\)/g;

const ALLOWANCES: ReadonlyMap<string, "Allowed" | "Refused"> = new Map(
  [...table.matchAll(ENTRY)].map((m) => [m[1], m[2] as "Allowed" | "Refused"])
);

/// Whether the table has the command at all, and lets a Device call it.
/// A command it does not name is refused, as the daemon refuses it.
export function allowedToRemoteRole(cmd: string): boolean {
  return ALLOWANCES.get(cmd) === "Allowed";
}

/// How many commands the table names: a parse that found none would
/// otherwise make every check here vacuous.
export function tableSize(): number {
  return ALLOWANCES.size;
}
