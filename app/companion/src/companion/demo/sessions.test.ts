// The Demo Workstation's sessions read what is typed into them the way
// real programs do, and say what they did the way a desk says it.
import { describe, expect, it, vi } from "vitest";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import { end, launch, repaint, screenText, type } from "$companion/demo/sessions";
import type { DemoContext } from "$companion/demo/commands";

function demo(): DemoContext & { heard: [string, unknown][] } {
  const heard: [string, unknown][] = [];
  return { state: sampleState(), emit: (event, payload) => void heard.push([event, payload]), heard };
}

const output = (d: DemoContext, id: string) => d.state.terminals[id].output;
/// What an agent said, its wrapped lines put back together.
const prose = (d: DemoContext, id: string) => output(d, id).replace(/\r\n {2}(?=\S)/g, " ");
const statuses = (d: ReturnType<typeof demo>) =>
  d.heard.filter(([e]) => e === "session-status-changed").map(([, p]) => p);

describe("a shell", () => {
  it("echoes what is typed and runs it on Enter", () => {
    const d = demo();
    type(d, "s-scratch", "echo hi");
    type(d, "s-scratch", "\r");
    expect(output(d, "s-scratch")).toMatch(/echo hi\r\nhi\r\n.*% $/);
    expect(d.heard.filter(([e]) => e === "pty-output").length).toBeGreaterThan(1);
  });

  it("goes where cd says and tells the desk its new folder", () => {
    const d = demo();
    type(d, "s-scratch", `cd ${DEMO.atlasRoot}\r`);
    expect(d.heard).toContainEqual(["cwd-changed", ["s-scratch", DEMO.atlasRoot]]);
    type(d, "s-scratch", "git status\r");
    expect(output(d, "s-scratch")).toContain("On branch main");
  });

  it("stops the line at ^C, and forgets a character at backspace", () => {
    const d = demo();
    type(d, "s-scratch", "lsx\x7f\r");
    expect(screenText(d.state.terminals["s-scratch"]).split("\n").at(-2)).toBe("code    notes.txt");
    type(d, "s-scratch", "rm -rf /\x03");
    expect(output(d, "s-scratch")).toMatch(/\^C\r\n.*% $/);
  });

  it("scrolls: seq prints as many lines as it is asked for", () => {
    const d = demo();
    type(d, "s-scratch", "seq 1 120\r");
    expect(screenText(d.state.terminals["s-scratch"], 200)).toContain("\n120\n");
  });
});

describe("an agent", () => {
  it("takes a menu's digit, answers, and goes to work", () => {
    const d = demo();
    type(d, "s-atlas-store", "1");
    expect(prose(d, "s-atlas-store")).toContain("Redis it is.");
    expect(statuses(d)).toEqual([["s-atlas-store", "working"]]);
  });

  it("takes Esc at a menu as no answer, and waits in its input box", () => {
    const d = demo();
    type(d, "s-atlas-store", "\x1b");
    expect(output(d, "s-atlas-store")).toMatch(/Interrupted.*\x1b\[\?2004h> $/s);
    expect(statuses(d)).toEqual([["s-atlas-store", "idle"]]);
  });

  it("reads a pasted line between its markers, and answers on the Enter after them", () => {
    const d = demo();
    type(d, "s-atlas-billing", "\x1b[200~always ISO\x1b[201~\r");
    expect(prose(d, "s-atlas-billing")).toContain("what you said: “always ISO”");
    // At work while it answers, then done.
    expect(statuses(d)).toEqual([
      ["s-atlas-billing", "working"],
      ["s-atlas-billing", "idle"],
    ]);
  });

  it("keeps a carriage return inside a paste as part of the text", () => {
    const d = demo();
    type(d, "s-atlas-main", "\x1b[200~one\rtwo\x1b[201~");
    expect(statuses(d)).toEqual([]);
    type(d, "s-atlas-main", "\r");
    expect(prose(d, "s-atlas-main")).toContain("“one\ntwo”");
  });

  it("is interrupted by Esc while it works", () => {
    const d = demo();
    type(d, "s-atlas-auth", "anything");
    expect(statuses(d)).toEqual([]);
    type(d, "s-atlas-auth", "\x1b");
    expect(output(d, "s-atlas-auth")).toContain("Interrupted by user");
    expect(statuses(d)).toEqual([["s-atlas-auth", "idle"]]);
  });
});

describe("a repaint", () => {
  it("is the whole output again, from a cleared screen and history", () => {
    const d = demo();
    repaint(d, "s-atlas-store");
    const [event, [id, bytes]] = d.heard[0] as [string, [string, string]];
    expect([event, id]).toEqual(["pty-output", "s-atlas-store"]);
    expect(bytes.startsWith("\x1b[?2004l\x1b[H\x1b[2J\x1b[3J")).toBe(true);
    expect(bytes.endsWith(output(d, "s-atlas-store"))).toBe(true);
  });
});

describe("the screen as text", () => {
  it("is the rows since the last clear, without escapes", () => {
    const d = demo();
    const screen = screenText(d.state.terminals["s-atlas-store"]);
    expect(screen).not.toMatch(/\x1b/);
    expect(screen.split("\n").slice(-6, -2)).toEqual([
      " ❯ 1. Redis — expiry built in, a new service",
      "   2. Postgres — deployed, needs a sweeper",
      "   3. Type something else",
      "",
    ]);
  });
});

describe("opening and ending a session", () => {
  it("opens a shell, or the agent a command names, and says so", () => {
    const d = demo();
    const shell = launch(d, { cwd: DEMO.notesRoot, command: null });
    const agent = launch(d, { cwd: null, command: "claude --model opus" });
    expect([shell, agent]).toEqual(["s-demo-1", "s-demo-2"]);
    expect(d.state.terminals[shell].program).toMatchObject({ kind: "shell", cwd: DEMO.notesRoot });
    expect(d.state.terminals[agent].program).toMatchObject({ kind: "agent" });
    expect(d.state.sessions.find((s) => s.id === agent)?.cwd).toBe(DEMO.home);
    expect(d.heard).toContainEqual(["session-status-changed", [shell, "idle"]]);
  });

  it("ends a session, then closes its tab at the desk -- in that order", () => {
    const d = demo();
    end(d, "s-atlas-store");
    expect(d.heard.map(([e]) => e)).toEqual(["session-exited", "workspaces-synced"]);
    const atlas = d.state.workspaces.workspaces.find((w) => w.id === DEMO.atlas)!;
    expect(atlas.pages.find((p) => p.name === "auth")?.layout).toMatchObject({ tabs: ["s-atlas-auth"] });
    expect(d.state.terminals["s-atlas-store"]).toBeUndefined();
    expect(d.state.sessions.some((s) => s.id === "s-atlas-store")).toBe(false);
  });

  it("removes a page left with nothing, and lets a workspace's own agent go", () => {
    const d = demo();
    end(d, "s-atlas-billing");
    end(d, "s-atlas-main");
    const atlas = d.state.workspaces.workspaces.find((w) => w.id === DEMO.atlas)!;
    expect(atlas.pages.map((p) => p.name)).toEqual(["auth"]);
    expect(atlas.mainSessionId).toBeUndefined();
  });

  it("says nothing about a tab for a session no page held", () => {
    const d = demo();
    const id = launch(d, { cwd: null, command: null });
    d.heard.length = 0;
    const synced = vi.fn();
    end({ ...d, emit: (event, payload) => (event === "workspaces-synced" ? synced() : d.emit(event, payload)) }, id);
    expect(synced).not.toHaveBeenCalled();
    expect(d.heard).toEqual([["session-exited", [id, 0]]]);
  });
});
