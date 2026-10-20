import { describe, expect, it } from "vitest";
import { isTerminalReport, mendMouseReports } from "$lib/terminal/terminalReport";

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

// xterm 6.1 turns a swipe into wheel reports once the program tracks the
// mouse, and keeps sending them through the swipe's momentum -- frames that
// carry no pointer position, so their coordinates come out `NaN`. Claude
// Code cannot parse those as reports and types them into its prompt.
describe("mendMouseReports", () => {
  it("leaves typing alone and remembers nothing from it", () => {
    expect(mendMouseReports("ls -la\r", null)).toEqual({ data: "ls -la\r", at: null });
    expect(mendMouseReports("NaN;NaNM", "4;7")).toEqual({ data: "NaN;NaNM", at: "4;7" });
  });

  it("remembers where the last whole report was", () => {
    expect(mendMouseReports("\x1b[<65;12;30M", null)).toEqual({ data: "\x1b[<65;12;30M", at: "12;30" });
    expect(mendMouseReports("\x1b[<64;1;1M\x1b[<64;2;3M", "9;9")).toEqual({
      data: "\x1b[<64;1;1M\x1b[<64;2;3M",
      at: "2;3",
    });
  });

  it("puts a momentum frame's report where the swipe last was", () => {
    expect(mendMouseReports("\x1b[<65;NaN;NaNM", "12;30")).toEqual({ data: "\x1b[<65;12;30M", at: "12;30" });
    expect(mendMouseReports("\x1b[<64;NaN;NaNM\x1b[<64;NaN;NaNM", "5;6")).toEqual({
      data: "\x1b[<64;5;6M\x1b[<64;5;6M",
      at: "5;6",
    });
  });

  it("drops a report with nowhere to put it", () => {
    expect(mendMouseReports("\x1b[<65;NaN;NaNM", null)).toEqual({ data: "", at: null });
  });

  it("mends a report among others and leaves them be", () => {
    expect(mendMouseReports("\x1b[<65;3;4M\x1b[<65;NaN;NaNMx", null)).toEqual({
      data: "\x1b[<65;3;4M\x1b[<65;3;4Mx",
      at: "3;4",
    });
  });

  it("what it mends is a report again", () => {
    expect(isTerminalReport(mendMouseReports("\x1b[<65;NaN;NaNM", "1;2").data)).toBe(true);
  });
});
