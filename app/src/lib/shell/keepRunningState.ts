// The live side of keep-running mode: the remote-access switch as this
// window knows it, and the idle-sleep hold it drives. Every rule is in
// keepRunning.ts; what is here is the state those rules read.
//
// The switch lives in the daemon's trust store, and until now only the
// Settings panel read it, when it opened. Two things need it all the
// time: what closing the main window does, and whether the Mac is held
// awake. So every window reads it once at bootstrap, and the host tells
// every window when Settings moves it (`remote-access-changed`) -- the
// window that flips it is often not the one holding the app's duties.

import { derived, get, writable, type Readable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { layoutState } from "$lib/core/layoutState";
import { agentSessions } from "$lib/agents/memoryState";
import { agentRunning, sleepHoldAction, SLEEP_HOLD_LINGER_MS, type SleepHoldAction } from "$lib/shell/keepRunning";

/// The daemon's remote-access switch, or null until it has been read --
/// and for good on a daemon too old to have one. keepRunning.ts reads
/// null as off.
export const remoteAccessEnabled = writable<boolean | null>(null);

export function remoteAccessNow(): boolean | null {
  return get(remoteAccessEnabled);
}

/// Loads the switch and keeps it current. The listener goes up first, so
/// a change made between the read and the subscription is not lost; and
/// a read that answers AFTER a change was heard is dropped, because it
/// may have been served before that change was written.
export async function initRemoteAccess(): Promise<UnlistenFn> {
  let heard = false;
  const unlisten = await listen<boolean>("remote-access-changed", (event) => {
    heard = true;
    remoteAccessEnabled.set(event.payload === true);
  });
  try {
    const list = await backend.listDevices();
    if (!heard) remoteAccessEnabled.set(list.remoteAccessEnabled);
  } catch {
    // A daemon that cannot answer -- or predates the switch -- leaves it
    // unknown, which is off.
  }
  return unlisten;
}

/// Tells the host whether to hold the Mac awake, whenever the answer
/// changes. Run by the window holding the app's duties
/// (`whileHoldingAppDuties`): that is where the memory poll keeps the
/// agent list this reads.
///
/// Its first answer always goes out, "no" included: a new holder must
/// clear a hold the last one left behind as surely as it must take one.
/// Nothing is released when it STOPS, though. The next holder sends its
/// own answer as it starts, and the two windows' starts and stops arrive
/// in no promised order -- a release from the old holder landing after
/// the new one's hold would let the Mac sleep under a running agent.
///
/// The linger is a plain `setTimeout`, which keeps time in a hidden
/// window only because keep_running.rs turns WebKit's hidden-page
/// throttling off.
///
/// Built when started, not at module scope: a module-level derived over
/// `layoutState` breaks every suite that mocks that module partially.
export function startSleepHold(): () => void {
  const action: Readable<SleepHoldAction> = derived(
    [remoteAccessEnabled, agentSessions, layoutState],
    ([remote, agents, layout]) =>
      sleepHoldAction(remote, agentRunning(Object.keys(agents), layout.sessionStatusById))
  );
  let sent: boolean | null = null;
  let linger: ReturnType<typeof setTimeout> | null = null;

  function send(hold: boolean): void {
    if (hold === sent) return;
    sent = hold;
    backend.setSleepHold(hold).catch(() => {
      // Unsent: the next change, or the next holder, tries again.
      sent = null;
    });
  }

  function stopLingering(): void {
    if (linger !== null) clearTimeout(linger);
    linger = null;
  }

  const unsubscribe = action.subscribe((next) => {
    if (next === "hold") {
      stopLingering();
      send(true);
    } else if (next === "release" || sent !== true) {
      // Nothing held means nothing to linger over -- but the first
      // answer still has to reach the host.
      stopLingering();
      send(false);
    } else if (linger === null) {
      linger = setTimeout(() => {
        linger = null;
        send(false);
      }, SLEEP_HOLD_LINGER_MS);
    }
  });
  return () => {
    unsubscribe();
    stopLingering();
  };
}
