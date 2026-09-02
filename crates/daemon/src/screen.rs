//! The daemon's model of what a session's screen *is*, as opposed to a log
//! of the bytes that got it there.
//!
//! A coding agent's TUI repaints in the normal screen buffer using relative
//! cursor motion, so its output is a stream of frame deltas that mean
//! something only against the screen state immediately before them. Replaying
//! a fixed-size tail of those bytes to a client that reconnects -- which is
//! what a raw ring buffer can offer -- hands it deltas with no frame to apply
//! them to, and it paints a half-drawn frame. Feeding the bytes through a
//! terminal parser instead lets a reconnect be answered with the screen
//! itself: clear, paint every row, put the cursor back.

/// Rows of scrolled-off output kept per session so a restored terminal still
/// has history above the restored screen.
///
/// Measured at 200x50 across 20 sessions: ~0.6 MB per session with no
/// scrollback, ~4 MB at 500 rows, ~7.5 MB at 1000 (vt100's Cell is 32 bytes,
/// and a scrolled-off row costs `cols` of them). 500 is picked for parity
/// with what the 64 KB raw ring this replaced actually yielded -- roughly 320
/// rows of dense output, more of sparse -- rather than to maximise history.
const SCROLLBACK_ROWS: usize = 500;

/// The PTY's size at spawn (see `PtySession::spawn`). The parser starts here
/// and follows the PTY through every `ResizeSession`, so a snapshot is always
/// rendered at the size the session actually believes it has.
const INITIAL_ROWS: u16 = 24;
const INITIAL_COLS: u16 = 80;

pub struct SessionScreen {
    parser: vt100::Parser,
}

impl Default for SessionScreen {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionScreen {
    pub fn new() -> Self {
        Self { parser: vt100::Parser::new(INITIAL_ROWS, INITIAL_COLS, SCROLLBACK_ROWS) }
    }

    /// Raw PTY bytes, exactly as read. Never pre-decoded to a `String`: the
    /// parser is a byte state machine that carries a partial UTF-8 sequence
    /// across calls itself, so a chunk boundary mid-character is its problem
    /// to solve rather than the caller's.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    pub fn set_size(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows, cols);
    }

    /// The visible grid as plain text, one line per row, with no escape
    /// sequences at all.
    ///
    /// The point of the parser, used for something other than repainting:
    /// an agent's error banner ("API Error: Connection dropped") arrives
    /// as a stream of fragments interleaved with cursor moves, so it is
    /// contiguous text HERE and nowhere else. `server.rs`'s
    /// `failure_on_screen` is the caller.
    ///
    /// Visible rows only, deliberately -- not the scrollback. A verdict
    /// is about the turn that just ended, and history is exactly what
    /// must not condemn it.
    pub fn contents(&self) -> String {
        self.parser.screen().contents()
    }

    /// A byte stream that reproduces this screen in a terminal that has never
    /// seen any of the session's output.
    ///
    /// Four parts, in order:
    ///
    /// 1. the scrolled-off rows, so history survives the restore;
    /// 2. enough blank lines to push that history above the viewport, because
    ///    part 3 opens by clearing the viewport and would otherwise wipe the
    ///    tail of the history it just printed;
    /// 3. `contents_formatted()` -- clear, every visible row, cursor position;
    /// 4. `input_mode_formatted()`, which is not decoration: application
    ///    cursor mode decides what an arrow key transmits, so a restore that
    ///    skipped it could look right and still mis-send keys.
    pub fn snapshot(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let (rows, cols) = self.parser.screen().size();

        if self.parser.screen().alternate_screen() {
            // The visible grid IS the alternate screen, which by definition
            // has no scrollback, and the normal screen underneath it is not
            // what this session is showing. Enter it and paint only that.
            out.extend_from_slice(b"\x1b[?1049h");
        } else {
            // A previous occupant of this terminal may have left it in the
            // alternate screen; this session is not in it.
            out.extend_from_slice(b"\x1b[?1049l");
            let history = self.history_rows(cols);
            if !history.is_empty() {
                for row in &history {
                    // Each row is written assuming it starts from default
                    // attributes and does not restore them at the end, so
                    // without this a row ending in colour would tint the next
                    // one. Cheap enough to emit unconditionally.
                    out.extend_from_slice(b"\x1b[m");
                    out.extend_from_slice(row);
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(b"\x1b[m");
                for _ in 0..rows {
                    out.extend_from_slice(b"\r\n");
                }
            }
        }

        let screen = self.parser.screen();
        out.extend_from_slice(&screen.contents_formatted());
        out.extend_from_slice(&screen.input_mode_formatted());
        out
    }

    /// The scrolled-off rows, oldest first, each as its own self-contained
    /// run of escape codes.
    ///
    /// `rows_formatted` is documented as leaving cursor positioning to the
    /// caller, which sounds like it rules this out -- but every move it can
    /// emit for a SINGLE row is same-row and forward, and `MoveFromTo`
    /// renders those as a relative `CUF`. Taking only the first row of each
    /// scrollback position therefore yields rows that concatenate under
    /// `\r\n` without any absolute positioning to fight.
    fn history_rows(&mut self, cols: u16) -> Vec<Vec<u8>> {
        let screen = self.parser.screen_mut();
        // set_scrollback clamps to what actually exists, so this asks for the
        // oldest row available and then reads back how far that was.
        screen.set_scrollback(usize::MAX);
        let total = screen.scrollback();
        let mut rows = Vec::with_capacity(total);
        for offset in (1..=total).rev() {
            screen.set_scrollback(offset);
            if let Some(row) = screen.rows_formatted(0, cols).next() {
                rows.push(row);
            }
        }
        screen.set_scrollback(0);
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_text(screen: &vt100::Screen, row: u16, cols: u16) -> String {
        (0..cols)
            .map(|c| screen.cell(row, c).map(|x| x.contents()).unwrap_or_default())
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    /// Renders `bytes` into a fresh parser and returns the visible screen as
    /// plain text -- the comparison every test here makes, since two byte
    /// streams that paint the same screen are equivalent for our purposes
    /// however differently they are spelled.
    fn painted(bytes: &[u8], rows: u16, cols: u16) -> Vec<String> {
        let mut p = vt100::Parser::new(rows, cols, 0);
        p.process(bytes);
        (0..rows).map(|r| row_text(p.screen(), r, cols)).collect()
    }

    /// Every line a viewer would have, scrollback included. A snapshot
    /// deliberately pushes its history ABOVE the viewport (see `snapshot`), so
    /// a scrollback-less parser is blind to exactly the part under test.
    fn painted_with_history(bytes: &[u8], rows: u16, cols: u16) -> Vec<String> {
        let mut p = vt100::Parser::new(rows, cols, 1000);
        p.process(bytes);
        let mut out = Vec::new();
        p.screen_mut().set_scrollback(usize::MAX);
        let total = p.screen().scrollback();
        for offset in (1..=total).rev() {
            p.screen_mut().set_scrollback(offset);
            out.push(row_text(p.screen(), 0, cols));
        }
        p.screen_mut().set_scrollback(0);
        out.extend((0..rows).map(|r| row_text(p.screen(), r, cols)));
        out
    }

    fn sized(rows: u16, cols: u16) -> SessionScreen {
        let mut s = SessionScreen::new();
        s.set_size(rows, cols);
        s
    }

    /// The foreground colour of the first cell of whichever line reads
    /// `text`, searching scrollback as well as the visible screen.
    fn colour_of_line(bytes: &[u8], text: &str, rows: u16, cols: u16) -> Option<vt100::Color> {
        let mut p = vt100::Parser::new(rows, cols, 1000);
        p.process(bytes);
        p.screen_mut().set_scrollback(usize::MAX);
        let total = p.screen().scrollback();
        for offset in (1..=total).rev() {
            p.screen_mut().set_scrollback(offset);
            if row_text(p.screen(), 0, cols) == text {
                return p.screen().cell(0, 0).map(|c| c.fgcolor());
            }
        }
        p.screen_mut().set_scrollback(0);
        (0..rows)
            .find(|r| row_text(p.screen(), *r, cols) == text)
            .and_then(|r| p.screen().cell(r, 0).map(|c| c.fgcolor()))
    }

    #[test]
    fn a_snapshot_of_a_tui_frame_repaints_it_exactly() {
        // The shape a coding agent's TUI actually emits: draw, then repaint
        // pieces of the frame by moving relative to where it already is.
        let stream: &[u8] = b"\x1b[H\x1b[Jheader\r\n\r\n> prompt\r\nfooter\x1b[3;3H\x1b[2Cedit\x1b[2A\x1b[4C!";
        let mut screen = sized(10, 40);
        screen.feed(stream);

        assert_eq!(
            painted(&screen.snapshot(), 10, 40),
            painted(stream, 10, 40),
            "a snapshot must paint the same screen the raw stream did"
        );
    }

    /// A real Claude Code session captured off a 120x40 PTY with
    /// TERM=xterm-256color: the agent starting, drawing its banner and input
    /// box, and repainting the box as a line is typed. It is the actual bug
    /// report in a file -- wide glyphs, OSC 8 hyperlinks, synchronised-output
    /// and kitty-keyboard sequences included, none of which a hand-written
    /// stream would have thought to contain.
    const REAL_AGENT_TUI: &[u8] = include_bytes!("../tests/fixtures/claude-code-tui.raw");

    #[test]
    fn a_real_agent_session_is_restored_exactly() {
        let mut screen = sized(40, 120);
        screen.feed(REAL_AGENT_TUI);
        assert_eq!(
            painted(&screen.snapshot(), 40, 120),
            painted(REAL_AGENT_TUI, 40, 120),
            "the snapshot must repaint a real agent's screen exactly"
        );
    }

    #[test]
    fn a_real_agent_session_is_the_case_a_raw_tail_gets_wrong() {
        // The other half of the same fixture: what the app does today. A tail
        // of the bytes -- which is all a ring buffer can offer once a
        // long-lived session's opening frame has rolled out of it -- is
        // deltas with no frame under them, and paints a broken one.
        let tail = &REAL_AGENT_TUI[REAL_AGENT_TUI.len() - 1500..];
        assert_ne!(
            painted(tail, 40, 120),
            painted(REAL_AGENT_TUI, 40, 120),
            "if a raw tail ever reproduced the screen, this fixture stopped \
             representing the bug and needs replacing"
        );
    }

    #[test]
    fn replaying_only_the_deltas_does_not_repaint_the_frame() {
        // The bug, stated as a test: this is what a hot-reloaded frontend
        // receives -- a blank terminal and the next repaint delta. If this
        // ever starts passing, raw deltas became sufficient and the screen
        // model is no longer earning its keep.
        let setup: &[u8] = b"\x1b[H\x1b[Jheader\r\n\r\n> prompt\r\nfooter";
        let delta: &[u8] = b"\x1b[3;3H\x1b[2Cedit";
        let mut whole = setup.to_vec();
        whole.extend_from_slice(delta);

        assert_ne!(
            painted(delta, 10, 40),
            painted(&whole, 10, 40),
            "deltas alone cannot reconstruct the frame they were computed against"
        );
    }

    #[test]
    fn scrolled_off_rows_come_back_above_the_restored_screen() {
        let mut screen = sized(4, 20);
        for i in 1..=10 {
            screen.feed(format!("line {i}\r\n").as_bytes());
        }
        let snapshot = screen.snapshot();

        // History and screen sit in the right order with nothing lost, and
        // nothing duplicated, between them.
        let lines: Vec<String> = painted_with_history(&snapshot, 4, 20)
            .into_iter()
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(
            lines,
            (1..=10).map(|i| format!("line {i}")).collect::<Vec<_>>(),
            "every line must appear exactly once, in order"
        );
    }

    #[test]
    fn the_clear_that_opens_the_screen_never_eats_the_history_it_just_printed() {
        // The blank-line push exists for this: without it, contents_formatted's
        // \e[H\e[J wipes whatever history is still inside the viewport.
        let mut screen = sized(4, 20);
        for i in 1..=10 {
            screen.feed(format!("line {i}\r\n").as_bytes());
        }
        // A viewport-sized terminal shows only the screen; the history has to
        // have gone somewhere above it, not been erased.
        let visible = painted(&screen.snapshot(), 4, 20);
        assert!(
            visible.iter().any(|l| l.contains("line 10")),
            "the live screen must be what is visible, got {visible:?}"
        );
    }

    #[test]
    fn history_rows_keep_their_colour() {
        let mut screen = sized(2, 20);
        screen.feed(b"\x1b[31mred\x1b[m\r\nplain\r\nthird\r\nfourth\r\n");
        let snapshot = screen.snapshot();
        assert!(
            snapshot.windows(5).any(|w| w == b"\x1b[31m"),
            "a scrolled-off row's SGR codes must survive into the snapshot"
        );
    }

    #[test]
    fn a_row_ending_in_colour_does_not_tint_the_next_one() {
        // Each history row is written assuming default attributes and does not
        // restore them afterwards, so row N's trailing colour would bleed into
        // row N+1 without the reset `snapshot` emits between them. "red" is
        // reset before the newline, so "plain" is genuinely uncoloured at the
        // source and must come back that way.
        let stream: &[u8] = b"\x1b[31mred\x1b[m\r\nplain\r\nthird\r\nfourth\r\n";
        let mut screen = sized(2, 20);
        screen.feed(stream);

        assert_eq!(
            colour_of_line(&screen.snapshot(), "plain", 2, 20),
            Some(vt100::Color::Default),
            "the row after a colour-leaking one must render in the default colour"
        );
        assert_eq!(
            colour_of_line(&screen.snapshot(), "red", 2, 20),
            Some(vt100::Color::Idx(1)),
            "and a genuinely coloured row must keep its colour"
        );
    }

    #[test]
    fn an_alternate_screen_session_is_restored_into_the_alternate_screen() {
        let mut screen = sized(5, 20);
        screen.feed(b"normal output\r\n\x1b[?1049h\x1b[H\x1b[Jfullscreen app");
        let snapshot = screen.snapshot();
        assert!(
            snapshot.starts_with(b"\x1b[?1049h"),
            "the restore has to enter the alternate screen before painting it"
        );
        let mut p = vt100::Parser::new(5, 20, 0);
        p.process(&snapshot);
        assert!(p.screen().alternate_screen());
    }

    #[test]
    fn a_normal_screen_session_leaves_the_alternate_screen_behind() {
        let mut screen = sized(5, 20);
        screen.feed(b"just a shell");
        assert!(
            screen.snapshot().starts_with(b"\x1b[?1049l"),
            "a terminal left in the alternate screen by whatever came before \
             must be brought back out of it"
        );
    }

    #[test]
    fn input_modes_ride_along_with_the_screen() {
        let mut screen = sized(5, 20);
        // Application cursor mode: what makes an arrow key send \eOA rather
        // than \e[A. Lost, and the restored session mis-sends keys.
        screen.feed(b"\x1b[?1hprompt");
        let snapshot = screen.snapshot();
        assert!(
            snapshot.windows(5).any(|w| w == b"\x1b[?1h"),
            "application cursor mode must be re-established by the snapshot"
        );
    }

    #[test]
    fn resizing_follows_the_pty_so_a_snapshot_is_rendered_at_the_live_size() {
        let mut screen = SessionScreen::new();
        screen.set_size(30, 100);
        screen.feed(b"x");
        let mut p = vt100::Parser::new(30, 100, 0);
        p.process(&screen.snapshot());
        assert_eq!(p.screen().size(), (30, 100));
    }

    #[test]
    fn a_snapshot_leaves_the_screen_readable_for_the_next_one() {
        // history_rows walks the scrollback by mutating the parser's view of
        // it; a snapshot that forgot to wind that back would return history
        // instead of the live screen the second time it was asked.
        let mut screen = sized(4, 20);
        for i in 1..=10 {
            screen.feed(format!("line {i}\r\n").as_bytes());
        }
        let first = screen.snapshot();
        let second = screen.snapshot();
        assert_eq!(first, second, "snapshots must be repeatable");
    }
}
