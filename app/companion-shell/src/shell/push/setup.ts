// Turning notifications on, and what the hub says about them (spec
// "Notifications"; smoke F1: the phone asks once, and the hub reflects the
// answer). At launch the hub checks without asking; the owner's tap on
// `Turn on notifications` is what asks. Either way, once iOS allows it the
// token goes to the Push gateway (`registration.ts`).
import type { PushPlugin } from "$shell/native/push";
import { gatewayClient } from "$shell/push/gateway";
import type { PushPlatform } from "$shell/push/permissions";
import { readRegistration, registerToken, type KeptRegistration } from "$shell/push/registration";

export type NotifySetup =
  /// Not yet known, or this phone's shell has no push (Android, a browser):
  /// the hub says nothing.
  | { state: "checking" }
  | { state: "unavailable" }
  | { state: "prompt" }
  | { state: "asking" }
  | { state: "denied" }
  /// Allowed, and the gateway has this install's token: `kept` is the
  /// registration the Workstations' permissions are minted under.
  | { state: "on"; fresh: boolean; kept: KeptRegistration }
  /// Allowed, but this build names no Push gateway to register with.
  | { state: "no-gateway" }
  | { state: "failed"; problem: string };

export interface SetupDeps {
  push: Pick<PushPlugin, "status" | "register" | "gateway" | "registration" | "keepRegistration">;
  platform: PushPlatform;
}

/// Where notifications stand. `ask` is the owner's tap: without it nothing
/// prompts, and a phone that was never asked stays at `prompt`.
export async function setUpNotifications(deps: SetupDeps, ask: boolean): Promise<NotifySetup> {
  const { push } = deps;
  let status;
  try {
    status = await push.status();
  } catch {
    return { state: "unavailable" };
  }
  if (status.permission === "denied") return { state: "denied" };
  if (status.permission !== "granted" && !ask) return { state: "prompt" };
  try {
    const registered = await push.register();
    if (registered.permission !== "granted") {
      return registered.permission === "denied" ? { state: "denied" } : { state: "prompt" };
    }
    if (!status.gateway) return { state: "no-gateway" };
    const { record } = await push.registration();
    const client = gatewayClient((r) => push.gateway(r));
    // Keep credentials as soon as register returns them so a live
    // verification push can confirm before settleTokenClaim finishes.
    const previous = readRegistration(record);
    const onCredentials = async (kept: KeptRegistration) => {
      await push.keepRegistration({ record: JSON.stringify(kept) });
    };
    const { kept, fresh } = await registerToken(
      client,
      previous,
      {
        gateway: status.gateway,
        platform: deps.platform,
        token: registered.token,
        environment: registered.environment,
      },
      onCredentials
    );
    if (fresh) await push.keepRegistration({ record: JSON.stringify(kept) });
    return { state: "on", fresh, kept };
  } catch (e) {
    return { state: "failed", problem: e instanceof Error ? e.message : String(e) };
  }
}

/// The hub's Notifications line, and the button under it; null when it
/// says nothing.
export function notifyLine(setup: NotifySetup): { text: string; action: string | null } | null {
  switch (setup.state) {
    case "checking":
    case "unavailable":
      return null;
    case "prompt":
      return { text: "Get a notification here when an agent at a Workstation waits on you.", action: "Turn on notifications" };
    case "asking":
      return { text: "Turning notifications on…", action: null };
    case "denied":
      return { text: "Notifications are off for Gavin. Turn them on in iOS Settings, Notifications, Gavin.", action: null };
    case "on":
      return { text: "Notifications are on for this phone.", action: null };
    case "no-gateway":
      return { text: "Notifications are allowed, but this build names no Push gateway to receive them through.", action: null };
    case "failed":
      return { text: `Notifications could not be turned on: ${setup.problem}.`, action: "Try again" };
  }
}
