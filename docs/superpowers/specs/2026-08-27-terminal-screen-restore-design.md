# Restoring a terminal's screen after a restart or a hot reload

## The bug

After the app restarts — or, in `tauri dev`, after any frontend edit hot
reloads the webview — a session's terminal comes back scrambled: a
half-drawn box border, a prompt line stranded in the middle of the pane,
the banner missing. It is worst for sessions running a coding agent.

## Why it happens

A running agent CLI is a TUI that repaints in the **normal** screen buffer
using **relative** cursor motion. A capture of a real Claude Code session
(120x40, `TERM=xterm-256color`) shows no `\e[?1049h` anywhere and frames
built out of `\e[2C\e[5A … \e[2D\e[5B`, `\e[103C\e[1A`, `\e[K`, `\e[2K`.
Every one of those bytes means something only against the exact screen
state that preceded it.

The app reconstructs that screen two different ways, and both are wrong:

- **App restart.** The daemon keeps a 64 KB ring of the session's raw PTY
  bytes and, on `Attach`, replays it. A long-lived agent session emits
  frame *deltas* forever, so a 64 KB window holds only deltas — never the
  frame that laid the screen out. The ring is also cut at an arbitrary
  byte, so the replay can begin in the middle of an escape sequence.
- **Frontend hot reload.** `Attach` happens once per app *process*
  (`session::attach_and_relay`), not per frontend load. A reloaded
  webview builds brand-new, empty `Terminal` objects and never asks for
  anything: the deltas that arrive next are painted onto a blank grid.

Rendering the real capture through a VT emulator shows both failures
exactly as reported — the top border comes back as 16 characters of a
120-character rule, and the banner is gone.

## The fix: send a screen, not a byte log

The daemon gains a `vt100::Parser` per session, fed the same raw bytes the
PTY pump already reads. It is the daemon's model of what the session's
screen *is*, rather than a log of how it got there. Restoring means
replaying that model:

    [scrolled-off history rows, one per line]
    [blank lines pushing the history above the viewport]
    screen.contents_formatted()   // clear, paint every row, place cursor
    screen.input_mode_formatted() // bracketed paste, application cursor…

Fed to a blank terminal this reproduces the source screen exactly — the
probe confirms byte-identical output against the full stream, where the
delta replay does not match at all.

`input_mode_formatted()` is not decoration. Application-cursor mode
decides what an arrow key transmits; today it is lost whenever the bytes
that set it scroll out of the ring, so a restored session can be visually
fine and still mis-send keys.

### Scrollback stays, at a measured price

`contents_formatted()` renders the viewport only, so the parser is given a
500-row scrollback and the snapshot prints those rows first. Measured at
200x50 with 20 sessions: ~0.6 MB per session with no scrollback, ~4 MB at
500 rows, ~7.5 MB at 1000. 500 is chosen for parity with what today's
64 KB ring actually yields (roughly 320 dense rows, more for sparse
output) rather than to maximise history. The raw ring is removed, not kept
alongside — one model of the screen, not two.

### Ordering is a correctness requirement

A delta applied twice corrupts a TUI frame just as badly as one applied
never. So the pump holds the session's parser lock across *both* feeding
the parser and writing the chunk to the attached writer, and a snapshot is
rendered and written under that same lock. A snapshot can then never
straddle a chunk that has been fed but not yet forwarded. Lock order is
parser -> `attached_writers` -> writer, on every path.

### `Request::Snapshot`, not a second `Attach`

The hot-reload path needs to ask for a repaint. `Attach` would do it, but
`Attach` also re-sends the `CwdChanged` / `StatusChanged` /
`SessionRestored` baselines — and `waiting_for_input` notifies
unconditionally (`notifications.ts`), so every hot reload would re-fire an
OS notification for every session waiting on the human. `Snapshot { id }`
pushes the screen and nothing else.

It is a new request variant, so `min_version_for` gates it by type — the
case that gate exists for — and PROTOCOL_VERSION goes to 18. A daemon
older than 18 refuses it and the frontend simply does not repaint, which
is exactly today's behaviour. No `FEATURE_MIN_VERSION` entry is needed:
this is a new request TYPE, not a widened payload, so the gate is real
rather than dead.

### The frontend asks once its listener is live

`getOrCreateTerminal` registers `pty-output` through an async `listen()`.
A snapshot requested before that resolves would be dropped on the floor,
so the request is chained onto the listen promise. It is also chained after
`fit()`: the snapshot is rendered at the PTY's size, so the parser has to
be resized first. Both `ResizeSession` and `Snapshot` ride the *streaming*
connection, and the daemon reads that socket's requests in order, so
awaiting the resize `invoke` -- which writes its bytes synchronously -- is
enough to order them.

## Not doing

- **A `SIGWINCH` nudge to make the TUI repaint itself.** Ink redraws on
  resize, but it erases its previous frame relative to where it believes
  the cursor is — which after a bad replay is wrong. It paints a second
  frame over the garbage instead of replacing it.
- **Fixing the ring's cut point.** A tail that never contains a full frame
  cannot be repaired by cutting it more carefully.
- **Restoring across a *daemon* restart.** The PTY is gone with the
  process; that non-goal is unchanged from the 2026-08-03 spec.
