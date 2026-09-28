// The remote shim for `@tauri-apps/api/event` (ADR 0003): a listener
// registered here is registered on the Workstation, which relays the
// events its desktop app emits to the Devices that asked for them.
import { channel, NOT_CONNECTED } from "$companion/remote/connection";

export type UnlistenFn = () => void;

export interface Event<T> {
  event: string;
  /// Tauri numbers its listeners, and the desktop's handlers are typed
  /// against an event that carries the number. Nothing in the app reads
  /// it; it is here so the shape is the one they were written for.
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;

let nextListenerId = 1;

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const client = channel();
  if (!client) throw NOT_CONNECTED;
  const id = nextListenerId++;
  try {
    return await client.listen<T>(event, (payload) => handler({ event, id, payload }));
  } catch (e) {
    throw e instanceof Error ? e.message : String(e);
  }
}

/// Refused: the channel carries events one way, from the Workstation.
///
/// On the desk this is how one window tells the others what it read or
/// wrote (appDuty.ts's `tellOtherWindows`). A Device is not one of the
/// desk's windows; what it changes reaches them as the Workstation's own
/// pushes, the way a change made by an agent does.
export async function emit(event: string, _payload?: unknown): Promise<void> {
  throw `the Companion cannot emit "${event}": events only travel from the Workstation`;
}
