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
