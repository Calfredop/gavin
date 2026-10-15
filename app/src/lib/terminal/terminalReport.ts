// Whether a terminal write is the terminal describing ITSELF rather than
// the human typing: a focus report, or nothing but mouse reports.
//
// The app's twin of the daemon's `is_focus_report` / `is_mouse_report`
// (server.rs), and it has to say the same thing. The daemon keeps these
// from dismissing its copy of the ↻ restored badge; this keeps them from
// dismissing the app's, which would otherwise disappear the moment the
// pointer crossed the tab and come back on the next reload.
//
// Both arrive through xterm's `onData` without anyone touching a key:
// a focus report whenever the textarea gains or loses focus (DEC 1004),
// and a mouse report per cell the pointer crosses once the program asks
// for any-motion tracking (DEC 1003) -- as Claude Code does since 2.1.x.
// Clicks and the wheel count as reports too; none of them is typing.
//
// SGR only (`ESC [ < Cb ; Cx ; Cy M|m`, which SGR-pixels shares): xterm
// hands the legacy X10 encoding to `onBinary`, which gavin does not
// forward.

const FOCUS_REPORTS = new Set(["\x1b[I", "\x1b[O"]);
const MOUSE_REPORTS = /^(?:\x1b\[<\d+;\d+;\d+[Mm])+$/;

export function isTerminalReport(data: string): boolean {
  return FOCUS_REPORTS.has(data) || MOUSE_REPORTS.test(data);
}

// An SGR report whatever its coordinates say, so one whose position is not
// a number is found as well as a whole one.
const ANY_MOUSE_REPORT = /\x1b\[<(\d+);([^;\x1b]*);([^;\x1b]*?)([Mm])/g;
const WHOLE = /^\d+$/;

/// Mends the mouse reports xterm sends without a position.
///
/// xterm 6.1 turns a swipe into wheel reports once the program tracks the
/// mouse (MouseService's touch handling), and keeps sending them through
/// the swipe's momentum. Those frames are synthesized gesture events with
/// no pointer on them, so the report's column and row come out `NaN` --
/// `ESC [ < 65 ; NaN ; NaN M` -- which no program parses as a report:
/// Claude Code typed them into its prompt as `NaN;NaNM…`. Every touch
/// screen produces them, the Companion's and a touch-screen desk's alike.
///
/// The momentum is the swipe still going, so its reports go where the
/// swipe last was: `at` is the `col;row` of the last whole report, carried
/// between calls by the caller. With nothing known yet the report is
/// dropped -- a wheel turn at a made-up cell is worse than one fewer.
export function mendMouseReports(data: string, at: string | null): { data: string; at: string | null } {
  if (!data.includes("\x1b[<")) return { data, at };
  let last = at;
  const mended = data.replace(ANY_MOUSE_REPORT, (report, button: string, col: string, row: string, end: string) => {
    if (WHOLE.test(col) && WHOLE.test(row)) {
      last = `${col};${row}`;
      return report;
    }
    return last === null ? "" : `\x1b[<${button};${last}${end}`;
  });
  return { data: mended, at: last };
}
