import { describe, expect, it } from "vitest";
import { isTerminalReport } from "$lib/terminal/terminalReport";

// The same cases the daemon's `every_sgr_mouse_report_is_the_terminal_and_nothing_else_is`
// holds `is_mouse_report` to, plus the focus reports: the two sides must
// agree about what is typing, or the badge this guards and the daemon's
// copy of it disagree until the next reload.
describe("isTerminalReport", () => {
  it.each([
    ["focus in", "\x1b[I"],
    ["focus out", "\x1b[O"],
    ["hover", "\x1b[<35;10;5M"],
    ["wheel down", "\x1b[<65;10;5M"],
    ["wheel up", "\x1b[<64;1;1M"],
    ["left press", "\x1b[<0;120;40M"],
    ["left release", "\x1b[<0;120;40m"],
    ["drag with the left button held", "\x1b[<32;3;4M"],
    ["hover with shift held", "\x1b[<51;10;5M"],
    ["SGR-pixels, which shares the shape", "\x1b[<35;812;644M"],
    ["two reports back to back", "\x1b[<35;10;5M\x1b[<35;11;5M"],
  ])("%s is the terminal describing itself", (_, data) => {
    expect(isTerminalReport(data)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["a keystroke", "x"],
    ["Enter", "\r"],
    ["an arrow key", "\x1b[A"],
    ["a report cut short", "\x1b[<35;10;5"],
    ["a coordinate missing", "\x1b[<35;10M"],
    ["an empty field", "\x1b[<;10;5M"],
    ["a fourth field", "\x1b[<35;10;5;1M"],
    ["a report with a keystroke behind it", "\x1b[<35;10;5Mx"],
    ["a keystroke in front of one", "x\x1b[<35;10;5M"],
    ["a focus report with a keystroke behind it", "\x1b[Ix"],
    ["a paste that happens to contain one", "\x1b[200~\x1b[<35;10;5M\x1b[201~"],
  ])("%s is typing", (_, data) => {
    expect(isTerminalReport(data)).toBe(false);
  });
});
