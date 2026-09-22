// The keyboard's route to the top bar's next button. ⇧⌘A is pressed at
// the window (keyboard.ts), far from the button, and "next" is decided
// by the button: it already holds the workspace's waiting list and where
// the human stands, and its bubble names the session a click lands on.
// So the button offers its jump here and the shortcut presses it -- the
// key and the click cannot disagree about where "next" is, and
// keyboard.ts stays free of the attention, board and rail stores its
// own tests would have to fake.
//
// A stack rather than one slot, because two buttons can be mounted for
// a moment while the top row changes hands (hub tab row to a page's
// actions row, or one pane's row to another's): the newest is the one
// on screen, and the one leaving must not take the newcomer's
// registration with it.

/// What the button offers: the jump to make right now, or null when
/// nothing in the workspace is waiting. Decided synchronously, so the
/// router knows whether to claim the key before anything awaits.
export type NextWaitingJump = () => (() => void) | null;

const providers: NextWaitingJump[] = [];

/// Offers a button's jump to the shortcut. Returns the withdrawal, which
/// removes exactly this registration and no other.
export function provideNextWaitingJump(jump: NextWaitingJump): () => void {
  providers.push(jump);
  return () => {
    const at = providers.lastIndexOf(jump);
    if (at >= 0) providers.splice(at, 1);
  };
}

/// The jump the shortcut should make, or null when there is none -- no
/// button on screen (no workspace open, or the app hub up), or nothing
/// waiting. Null leaves the key for whatever else wants it.
export function nextWaitingJump(): (() => void) | null {
  return providers.at(-1)?.() ?? null;
}
