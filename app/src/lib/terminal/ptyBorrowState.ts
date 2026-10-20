// Which Device each session's PTY is sized for, one copy per desk window
// (v74). The rules are `ptyBorrow.ts`'s; this is the store, the listener and
// "Fit here".
//
// The desk only. The host does not offer the push on to Devices -- the Device
// that borrowed knows -- and the Companion never watches, so its terminal
// never draws a bar about its own screen.
//
// No read-back request: a desk that reloads mid-borrow refits every terminal
// it shows, the daemon holds that resize back, and says again who has the
// size. So the bar comes back exactly where a terminal is on screen.

import { writable, type Readable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { withBorrow, type Borrows, type PtySizeBorrowed } from "$lib/terminal/ptyBorrow";

const borrows = writable<Borrows>({});

export const borrowBySessionId: Readable<Borrows> = { subscribe: borrows.subscribe };

/// Starts listening; returns the stop. Called once per desk window.
export function watchPtyBorrows(): () => void {
  borrows.set({});
  const stop: Promise<UnlistenFn> = listen<PtySizeBorrowed>("pty-size-borrowed", (event) =>
    borrows.update((b) => withBorrow(b, event.payload))
  );
  return () => {
    void stop.then((off) => off());
    borrows.set({});
  };
}

/// "Fit here": the desk's size back now. The bar goes at once; the push
/// that follows says the same.
export async function returnPtySize(sessionId: string): Promise<void> {
  borrows.update((b) => withBorrow(b, { sessionId, device: null }));
  await backend.returnPtySize(sessionId);
}
