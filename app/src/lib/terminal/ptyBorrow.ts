/// Which Device each session's PTY is sized for (v74), as the desk draws it.
///
/// A PTY has one size, and a phone has to shrink it to be readable, so a
/// Device looking at a session borrows its size: the daemon holds the
/// desk's refits back meanwhile and gives the desk its size back when the
/// Device closes the terminal or goes away (`crates/daemon/src/pty_borrow.rs`).
/// While it lasts the desk's terminal is drawn narrower than its pane, and
/// the bar these words are for says why, and takes the size back.
///
/// Pure, so the rules have a suite; `ptyBorrowState.ts` holds the store.

/// A Device as the push names it.
export interface BorrowingDevice {
  deviceId: string;
  name: string;
}

/// The `pty-size-borrowed` event: whose screen the session is sized for,
/// or `null` once the desk has its size back.
export interface PtySizeBorrowed {
  sessionId: string;
  device: BorrowingDevice | null;
}

export type Borrows = Record<string, BorrowingDevice>;

/// The borrows after one push, whole per session.
export function withBorrow(borrows: Borrows, push: PtySizeBorrowed): Borrows {
  const { [push.sessionId]: _was, ...rest } = borrows;
  return push.device ? { ...rest, [push.sessionId]: push.device } : rest;
}

/// The bar's heading: "Open on iPhone".
export function borrowTitle(device: BorrowingDevice): string {
  return `Open on ${device.name}`;
}

/// The bar's second line.
export const BORROW_DETAIL = "Sized for its screen until it closes this terminal";

/// The bar's button: puts the desk's size back now.
export const BORROW_ACTION = "Fit here";
