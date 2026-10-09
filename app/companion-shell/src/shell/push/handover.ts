// Handing each paired Workstation this phone's permission to notify it
// (spec "The Push gateway": the Device mints one send permission per
// Workstation and hands it over their encrypted channel; cancelling one
// silences that Workstation and no other).
//
// A permission is minted at the gateway for every paired Workstation the
// owner has not turned off, renewed before it runs out, and cancelled for
// one that is turned off or no longer paired (`permissions.ts`). Each is
// handed to its Workstation over the live connection
// (`SetThisDeviceSendPermission`, protocol v67), once per connection and
// permission: the Workstation keeps it in its trust store, and a phone
// that reconnects hands it again in case the Workstation lost it. A
// Workstation turned off is told, with an empty permission, as well as
// having its permission cancelled at the gateway.
import { writable, type Readable } from "svelte/store";
import type { Connection } from "$shell/connection/connection";
import {
  ensureWorkstationPermissions,
  type PushGatewayClient,
  type WorkstationPermission,
} from "$shell/push/permissions";
import type { KeptRegistration } from "$shell/push/registration";

/// What the hub says of a Workstation's notifications.
export type WorkstationNotify =
  /// It holds this phone's permission: it can notify.
  | "on"
  /// The owner turned it off.
  | "off"
  /// Not handed over yet: it is not connected, or the hand-over is under way.
  | "waiting"
  /// Its Gavin is older than the hand-over (v67).
  | "too-old"
  | "failed";

/// What a Workstation answered a hand-over. Thrown as the reason when it
/// was not `Ok`.
export class HandoverRefused extends Error {
  constructor(
    readonly tooOld: boolean,
    message: string
  ) {
    super(message);
    this.name = "HandoverRefused";
  }
}

export const HANDOVER_TIMEOUT_MS = 10_000;

/// Hands `permission` to the Workstation at the far end of `connection`;
/// an empty one takes it back. A Workstation that does not know the
/// request -- an older daemon reads it as `Unknown` and refuses it to a
/// Device as `Forbidden` -- is too old to notify.
export async function handOver(connection: Connection, permission: string): Promise<void> {
  const reply = (await connection.request(
    { type: "SetThisDeviceSendPermission", permission },
    (r) => isAnswer(r),
    HANDOVER_TIMEOUT_MS
  )) as { type: string; message?: unknown };
  if (reply.type === "Ok") return;
  if (reply.type === "Forbidden" || reply.type === "Unsupported") {
    throw new HandoverRefused(true, "its Gavin is too old to notify this phone. Update Gavin at the desk");
  }
  throw new HandoverRefused(false, typeof reply.message === "string" ? reply.message : "it refused the permission");
}

function isAnswer(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  const type = (r as { type?: unknown }).type;
  return type === "Ok" || type === "Error" || type === "Forbidden" || type === "Unsupported";
}

export interface HandoverDeps {
  client: PushGatewayClient;
  /// Hands a permission to a connected Workstation (`handOver` over its
  /// connection); null when it is not connected.
  hand(workstationId: string, permission: string): Promise<void> | null;
  /// Keeps the registration, its permissions and its muted list.
  keep(record: KeptRegistration): Promise<void>;
  /// Unix seconds.
  now(): number;
}

/// One pass. `handed` is what this app run has handed already, by
/// `handoverKey`; the pass adds to it. Returns the registration as it now
/// stands and what to say of each paired Workstation.
export async function syncHandover(
  deps: HandoverDeps,
  kept: KeptRegistration,
  paired: readonly string[],
  handed: Set<string>,
  refused: Map<string, HandoverRefused>
): Promise<{ kept: KeptRegistration; status: Record<string, WorkstationNotify> }> {
  const wanted = paired.filter((id) => !kept.muted.includes(id));
  const { next } = await ensureWorkstationPermissions(
    deps.client,
    { deviceId: kept.deviceId, deviceSecret: kept.deviceSecret },
    wanted,
    kept.permissions,
    deps.now()
  );
  let record = kept;
  if (!samePermissions(next, kept.permissions)) {
    record = { ...kept, permissions: next };
    await deps.keep(record);
  }

  const status: Record<string, WorkstationNotify> = {};
  for (const id of paired) {
    const muted = record.muted.includes(id);
    const permission = muted ? "" : next.find((p) => p.workstationId === id)?.permission;
    if (permission === undefined) {
      status[id] = "failed";
      continue;
    }
    const key = handoverKey(id, permission);
    if (!handed.has(key)) {
      const handing = deps.hand(id, permission);
      if (handing) {
        try {
          await handing;
          handed.add(key);
          refused.delete(id);
        } catch (e) {
          refused.set(id, e instanceof HandoverRefused ? e : new HandoverRefused(false, String(e)));
        }
      }
    }
    const refusal = refused.get(id);
    status[id] = handed.has(key)
      ? muted
        ? "off"
        : "on"
      : refusal
        ? refusal.tooOld
          ? "too-old"
          : "failed"
        : muted
          ? "off"
          : "waiting";
  }
  return { kept: record, status };
}

/// What a hand-over is remembered by: which Workstation, and which
/// permission ("" for "turned off").
export function handoverKey(workstationId: string, permission: string): string {
  return `${workstationId}\n${permission}`;
}

/// The registration with `workstationId` turned on or off.
export function withMuted(kept: KeptRegistration, workstationId: string, muted: boolean): KeptRegistration {
  const others = kept.muted.filter((id) => id !== workstationId);
  return { ...kept, muted: muted ? [...others, workstationId] : others };
}

function samePermissions(a: readonly WorkstationPermission[], b: readonly WorkstationPermission[]): boolean {
  return a.length === b.length && a.every((p, i) => p.permissionId === b[i].permissionId && p.workstationId === b[i].workstationId);
}

/// The hub's word for a Workstation's notifications.
export function notifyWord(status: WorkstationNotify | undefined): string {
  switch (status) {
    case "on":
      return "Notifies";
    case "off":
      return "Off";
    case "too-old":
      return "Update Gavin at the desk to get its notifications";
    case "failed":
      return "Could not be set up";
    case "waiting":
    case undefined:
      return "Set up when it connects";
  }
}

export interface Handover {
  /// What to say of each paired Workstation, by id.
  readonly status: Readable<Record<string, WorkstationNotify>>;
  /// The registration to mint under, once notifications are on; null
  /// while they are not, which hands nothing over. The same Device's
  /// registration again changes nothing: the one held here has the
  /// permissions minted since, which a copy read before them has not.
  use(kept: KeptRegistration | null): void;
  /// A pass over these paired Workstations: on a change of pairing, and
  /// whenever one connects.
  sync(paired: readonly string[]): void;
  /// The owner turned one Workstation's notifications off or on.
  setMuted(workstationId: string, muted: boolean): void;
}

/// Passes run one at a time; one asked for meanwhile runs after, with the
/// latest pairing.
export function createHandover(deps: HandoverDeps & { log?(line: string): void }): Handover {
  const status = writable<Record<string, WorkstationNotify>>({});
  const handed = new Set<string>();
  const refused = new Map<string, HandoverRefused>();
  let kept: KeptRegistration | null = null;
  let paired: readonly string[] = [];
  let running = false;
  let again = false;

  async function run(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (!kept) {
          status.set({});
          continue;
        }
        const working = kept;
        try {
          const pass = await syncHandover(deps, working, paired, handed, refused);
          // A toggle that landed during the pass kept its own record.
          if (kept === working) kept = pass.kept;
          else again = true;
          status.set(pass.status);
        } catch (e) {
          deps.log?.(`[gavin-push] hand-over: ${e instanceof Error ? e.message : String(e)}`);
          status.set(Object.fromEntries(paired.map((id) => [id, working.muted.includes(id) ? "off" : "failed"])));
        }
      } while (again);
    } finally {
      running = false;
    }
  }

  return {
    status: { subscribe: status.subscribe },
    use(next) {
      const same = kept !== null && next !== null && kept.gateway === next.gateway && kept.deviceId === next.deviceId;
      if (!same) kept = next;
      void run();
    },
    sync(next) {
      paired = [...next];
      void run();
    },
    setMuted(workstationId, muted) {
      if (!kept) return;
      kept = withMuted(kept, workstationId, muted);
      const record = kept;
      void deps.keep(record).finally(() => void run());
    },
  };
}
