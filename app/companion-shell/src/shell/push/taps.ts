// What the hub does with notifications once they are on screen: opening
// the one the owner tapped, and clearing the ones the desk has dealt with.
import type { LiveState } from "$shell/hub/live";
import type { HubWorkstation } from "$shell/hub/workstations";
import type { NotifyLanding } from "$shell/push/decrypt";
import type { UnlockState } from "$shell/unlock/unlock";

/// How long after the Unlock a tapped notification still opens its
/// Workstation. A tap on a locked phone waits for Face ID and then for the
/// connection; one that takes longer is offline, and opening it whenever
/// it comes back would pull the owner out of whatever they turned to.
export const TAP_WINDOW_MS = 15_000;

/// A tapped notification, waiting to open.
export interface PendingTap extends NotifyLanding {
  /// When the Unlock was there for it, by the page's clock; null while it
  /// is not.
  unlockedAt: number | null;
}

export function pendingTap(landing: NotifyLanding): PendingTap {
  return { ...landing, unlockedAt: null };
}

/// One step towards opening a tapped notification. `open` is the
/// Workstation to open now, where the tap lands; `notice` is the hub's line
/// when it cannot be.
export function stepTap(
  pending: PendingTap | null,
  unlock: UnlockState,
  workstations: readonly HubWorkstation[],
  now: number
): { pending: PendingTap | null; open: { workstation: HubWorkstation; landing: NotifyLanding["landing"] } | null; notice: string | null } {
  if (!pending) return { pending: null, open: null, notice: null };
  const workstation = workstations.find((ws) => ws.id === pending.workstationId);
  if (!workstation) {
    return { pending: null, open: null, notice: "That notification is from a Workstation this phone is no longer paired with." };
  }
  if (unlock.state !== "unlocked") {
    return { pending: pending.unlockedAt === null ? pending : { ...pending, unlockedAt: null }, open: null, notice: null };
  }
  const unlockedAt = pending.unlockedAt ?? now;
  if (workstation.openable) return { pending: null, open: { workstation, landing: pending.landing }, notice: null };
  if (now - unlockedAt > TAP_WINDOW_MS) {
    return { pending: null, open: null, notice: `${workstation.name} cannot be reached to open what you tapped.` };
  }
  return { pending: { ...pending, unlockedAt }, open: null, notice: null };
}

/// The notifications to clear: on each Workstation that has answered what
/// is waiting, every one whose item is no longer waiting. `sent` is what
/// was last cleared against, so an answer that changed nothing clears
/// nothing again; the returned `sent` replaces it.
///
/// An item's id is the attention item's id: the desk pushes under the same
/// ids its attention answer names.
export function clearsFor(
  live: Readonly<Record<string, LiveState>>,
  sent: ReadonlyMap<string, string>
): { clears: { workstation: string; keep: string[] }[]; sent: Map<string, string> } {
  const next = new Map(sent);
  const clears: { workstation: string; keep: string[] }[] = [];
  for (const [workstation, state] of Object.entries(live)) {
    if (state.state !== "ready") continue;
    const keep = state.items.map((item) => item.id).sort();
    const signature = keep.join("\n");
    if (sent.get(workstation) === signature) continue;
    next.set(workstation, signature);
    clears.push({ workstation, keep });
  }
  return { clears, sent: next };
}
