// The Demo Workstation's terminals: what each session does with what is
// typed into it, and what opening and ending one does to the machine.
//
// A session here is a script, not a process. An agent waits in its input
// box, asks in a menu, or works until interrupted; a shell knows a
// handful of commands. What matters is that every byte the phone sends
// is read the way a real program reads it -- a paste arrives between its
// markers, a menu takes its digit, Esc interrupts -- because the phone's
// typing is what the demo is there to show, and what its suites drive.
//
// Every change is said the way a desk says it: the output as `pty-output`,
// the status as `session-status-changed`, an ending as `session-exited`
// and the tab it closes as `workspaces-synced`.
import { placeDeviceSession } from "$lib/core/devicePresence";
import * as workspace from "$lib/core/workspace";
import type { SessionBaseline } from "$lib/core/backend";
import * as layout from "$lib/panes/layout";
import type { DemoContext } from "$companion/demo/commands";
import { DEMO } from "$companion/demo/sampleData";
import { COMPOSER, LEAVE_COMPOSER, prompt, rows, said } from "$companion/demo/transcripts";

export interface MenuChoice {
  /// What the agent writes once this option is chosen.
  reply: string;
  /// Where that leaves it: at work, or back in its input box.
  then: "working" | "composer";
}

/// What an agent is waiting for.
export type AgentAsk =
  /// Its input box, for a line.
  | { kind: "composer" }
  /// One of a numbered menu's options, by digit.
  | { kind: "menu"; choices: MenuChoice[] }
  /// Nothing: it is busy, and only Esc or Ctrl-C reach it.
  | { kind: "working" };

export type DemoProgram =
  | { kind: "shell"; cwd: string; line: string }
  | {
      kind: "agent";
      ask: AgentAsk;
      /// What is typed in its input box so far.
      line: string;
      /// Its answer to the next line, `{text}` standing for the line --
      /// for an agent that asked a question and knows what to say to the
      /// answer. Null for the demo's stock answer.
      reply: string | null;
    };

export interface DemoTerminal {
  /// Everything the session has written. A snapshot replays it.
  output: string;
  program: DemoProgram;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/// A terminal repainted from nothing: modes back to their defaults, the
/// screen and its history cleared, then the whole output again.
const REPAINT = "\x1b[?2004l\x1b[H\x1b[2J\x1b[3J";
const CLEAR = "\x1b[H\x1b[2J";
/// One key or one run of text, the way a program reading a TTY splits
/// what arrives.
const TOKEN = /\x1b\[200~|\x1b\[201~|\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\x00-\x1f\x7f]|[^\x00-\x1f\x7f\x1b]+/gu;

const STOCK_REPLY =
  "This is the Demo Workstation, whose agents act out a script, so “{text}” goes no further. On a real Workstation the agent would take it from here.";

export function setStatus(demo: DemoContext, sessionId: string, status: string): void {
  const session = demo.state.sessions.find((s) => s.id === sessionId);
  if (!session || session.status === status) return;
  session.status = status;
  demo.emit("session-status-changed", [sessionId, status]);
}

/// The session writes: its output grows and whoever listens sees it.
export function write(demo: DemoContext, sessionId: string, bytes: string): void {
  const terminal = demo.state.terminals[sessionId];
  if (!terminal) return;
  terminal.output += bytes;
  demo.emit("pty-output", [sessionId, bytes]);
}

/// What `snapshot_session` asks for: the terminal painted again from
/// nothing, history and all.
export function repaint(demo: DemoContext, sessionId: string): void {
  const terminal = demo.state.terminals[sessionId];
  if (!terminal) return;
  demo.emit("pty-output", [sessionId, REPAINT + terminal.output]);
}

/// Puts a session's terminal back as it was, and repaints it.
export function restore(demo: DemoContext, sessionId: string, fresh: DemoTerminal): void {
  if (!demo.state.terminals[sessionId]) return;
  demo.state.terminals[sessionId] = fresh;
  repaint(demo, sessionId);
}

// ---- Typing ------------------------------------------------------------

/// What `write_input` hands a session.
export function type(demo: DemoContext, sessionId: string, data: string): void {
  const terminal = demo.state.terminals[sessionId];
  if (!terminal) return;
  let pasting = false;
  for (const [token] of data.matchAll(TOKEN)) {
    if (token === PASTE_START) pasting = true;
    else if (token === PASTE_END) pasting = false;
    else if (terminal.program.kind === "shell") shellKey(demo, sessionId, terminal.program, token);
    else agentKey(demo, sessionId, terminal.program, token, pasting);
  }
}

function isText(token: string): boolean {
  return !/^[\x00-\x1f\x7f\x1b]/.test(token);
}

/// Line editing, as a cooked line or an agent's input box does it.
function edit(demo: DemoContext, sessionId: string, program: { line: string }, token: string): boolean {
  if (isText(token)) {
    program.line += token;
    write(demo, sessionId, token);
    return true;
  }
  if (token === "\x7f" || token === "\b") {
    if (program.line !== "") {
      program.line = [...program.line].slice(0, -1).join("");
      write(demo, sessionId, "\b \b");
    }
    return true;
  }
  return false;
}

function agentKey(
  demo: DemoContext,
  sessionId: string,
  program: Extract<DemoProgram, { kind: "agent" }>,
  token: string,
  pasting: boolean
): void {
  const { ask } = program;
  if (ask.kind === "working") {
    if (token === "\x1b" || token === "\x03") {
      write(demo, sessionId, rows("", `  ⎿  Interrupted by user`, "") + COMPOSER);
      program.ask = { kind: "composer" };
      setStatus(demo, sessionId, "idle");
    }
    return;
  }
  if (ask.kind === "menu") {
    const picked = token === "\r" ? 1 : /^\d$/.test(token) ? Number(token) : null;
    const choice = picked === null ? undefined : ask.choices[picked - 1];
    if (choice) {
      write(demo, sessionId, choice.reply);
      if (choice.then === "working") {
        program.ask = { kind: "working" };
        setStatus(demo, sessionId, "working");
      } else {
        write(demo, sessionId, rows("") + COMPOSER);
        program.ask = { kind: "composer" };
        setStatus(demo, sessionId, "idle");
      }
    } else if (token === "\x1b") {
      write(demo, sessionId, rows("", `  ⎿  Interrupted · What should Claude do instead?`, "") + COMPOSER);
      program.ask = { kind: "composer" };
      setStatus(demo, sessionId, "idle");
    }
    return;
  }
  // The input box. Inside a paste a carriage return is part of the text,
  // which is the whole reason agents ask for the markers.
  if (pasting && token === "\r") {
    program.line += "\n";
    write(demo, sessionId, "\r\n  ");
    return;
  }
  if (edit(demo, sessionId, program, token)) return;
  if (token === "\x03" && program.line !== "") {
    program.line = "";
    write(demo, sessionId, "\r\x1b[2K> ");
    return;
  }
  if (token !== "\r") return;
  const line = program.line;
  program.line = "";
  write(demo, sessionId, `${LEAVE_COMPOSER}\r\n`);
  setStatus(demo, sessionId, "working");
  const answer = (program.reply ?? STOCK_REPLY).replace("{text}", line.trim() || "(nothing)");
  program.reply = null;
  write(demo, sessionId, rows("", ...said(answer), "") + COMPOSER);
  setStatus(demo, sessionId, "idle");
}

// ---- A shell -----------------------------------------------------------

/// The demo's disk: every folder a shell can be in, and what `ls` finds.
function folders(): Record<string, string[]> {
  return {
    [DEMO.home]: ["code", "notes.txt"],
    [`${DEMO.home}/code`]: ["atlas-api", "field-notes"],
    [DEMO.atlasRoot]: ["README.md", "docs", "package.json", "services", "src"],
    [DEMO.notesRoot]: ["README.md", "package.json", "src"],
  };
}

function folderLabel(cwd: string): string {
  return cwd === DEMO.home ? "~" : (cwd.split("/").pop() ?? cwd);
}

function resolve(cwd: string, to: string | undefined): string | null {
  if (to === undefined || to === "~") return DEMO.home;
  const target = to.startsWith("/") ? to : to.startsWith("~/") ? `${DEMO.home}/${to.slice(2)}` : `${cwd}/${to}`;
  const parts: string[] = [];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const path = `/${parts.join("/")}`;
  return path in folders() ? path : null;
}

function run(cwd: string, line: string): { output: string; cwd: string } {
  const [command = "", ...args] = line.trim().split(/\s+/);
  switch (command) {
    case "":
      return { output: "", cwd };
    case "ls":
      return { output: rows((folders()[resolve(cwd, args[0]) ?? cwd] ?? []).join("    ")), cwd };
    case "pwd":
      return { output: rows(cwd), cwd };
    case "echo":
      return { output: rows(args.join(" ")), cwd };
    case "cd": {
      const to = resolve(cwd, args[0]);
      return to ? { output: "", cwd: to } : { output: rows(`cd: no such file or directory: ${args[0]}`), cwd };
    }
    case "clear":
      return { output: CLEAR, cwd };
    case "seq": {
      const [from, to] = args.length > 1 ? [Number(args[0]), Number(args[1])] : [1, Number(args[0])];
      if (!Number.isInteger(from) || !Number.isInteger(to)) return { output: rows("seq: invalid number"), cwd };
      const numbers: string[] = [];
      for (let n = from; n <= Math.min(to, from + 999); n++) numbers.push(String(n));
      return { output: rows(...numbers), cwd };
    }
    case "git":
      return cwd === DEMO.atlasRoot || cwd === DEMO.notesRoot
        ? { output: rows("On branch main", "nothing to commit, working tree clean"), cwd }
        : { output: rows("fatal: not a git repository (or any of the parent directories): .git"), cwd };
    case "claude":
    case "codex":
      return {
        output: rows("The Demo Workstation starts no agent from a shell. Open one with New agent instead."),
        cwd,
      };
    case "help":
      return { output: rows("This shell knows: ls, cd, pwd, echo, seq, git status, clear."), cwd };
    default:
      return { output: rows(`zsh: command not found: ${command}`), cwd };
  }
}

function shellKey(
  demo: DemoContext,
  sessionId: string,
  program: Extract<DemoProgram, { kind: "shell" }>,
  token: string
): void {
  if (edit(demo, sessionId, program, token)) return;
  if (token === "\r") {
    const result = run(program.cwd, program.line);
    program.line = "";
    write(demo, sessionId, `\r\n${result.output}`);
    if (result.cwd !== program.cwd) {
      program.cwd = result.cwd;
      demo.emit("cwd-changed", [sessionId, result.cwd]);
    }
    write(demo, sessionId, prompt(folderLabel(program.cwd)));
  } else if (token === "\x03") {
    program.line = "";
    write(demo, sessionId, `^C\r\n${prompt(folderLabel(program.cwd))}`);
  } else if (token === "\x0c") {
    write(demo, sessionId, CLEAR + prompt(folderLabel(program.cwd)) + program.line);
  }
}

// ---- Opening and ending sessions ---------------------------------------

function baseline(id: string, cwd: string, status: string): SessionBaseline {
  return { id, cwd, status, restored: false, interrupted: false, orphan: null, failureReason: null };
}

/// A command as its terminal's first line shows it: a card's run carries
/// its whole prompt, which a screen echoing it verbatim would spend
/// itself on.
function commandLine(command: string): string {
  const first = command.split("\n")[0];
  return first.length > 48 || first !== command ? `${first.slice(0, 48).trimEnd()}…` : first;
}

/// What `create_session` starts: the agent a command names, else a shell.
///
/// Every session the demo starts is a Device's -- a phone is the demo's
/// only client -- so the desk places it as a Device-started session is
/// placed (companion-16): as a tab on its workspace's Agents page, the
/// page a card's run lands on, and says so. A session under no
/// workspace's folder is left running where nobody at the desk placed it.
///
/// One started as the workspace's own agent becomes it, by the desk's rule
/// (`placeDeviceSession`): when the workspace has a folder and no agent.
///
/// `place` is for the one session the demo starts that is NOT a Device's:
/// a rail's step, which the desk's own scheduler places on the rail's
/// page (railCommands.ts).
export function launch(
  demo: DemoContext,
  options: {
    cwd: string | null;
    command: string | null;
    workspaceRoot?: string | null;
    workspaceAgent?: boolean;
    place?: (sessionId: string) => void;
  }
): string {
  demo.state.launched += 1;
  const id = `s-demo-${demo.state.launched}`;
  const cwd = options.cwd || DEMO.home;
  demo.state.sessions.push(baseline(id, cwd, "idle"));
  demo.state.terminals[id] = options.command
    ? {
        output:
          rows(
            `✻ ${commandLine(options.command)}`,
            "",
            ...said("Ready when you are. This is the Demo Workstation's agent: it acts out a script and changes nothing."),
            ""
          ) + COMPOSER,
        program: { kind: "agent", ask: { kind: "composer" }, line: "", reply: null },
      }
    : { output: prompt(folderLabel(cwd)), program: { kind: "shell", cwd, line: "" } };
  demo.emit("cwd-changed", [id, cwd]);
  demo.emit("session-status-changed", [id, "idle"]);
  if (options.place) options.place(id);
  else placeAtDesk(demo, id, options.workspaceRoot || options.cwd, options.workspaceAgent === true);
  return id;
}

/// The workspace a Device-started session belongs in: the one whose root
/// holds where it started, the deepest when roots nest.
function workspaceHolding(demo: DemoContext, where: string | null | undefined): string | null {
  if (!where) return null;
  const holding = demo.state.workspaces.workspaces
    .filter((w) => w.rootPath && (where === w.rootPath || where.startsWith(`${w.rootPath}/`)))
    .sort((a, b) => (b.rootPath?.length ?? 0) - (a.rootPath?.length ?? 0));
  return holding[0]?.id ?? null;
}

/// The tab the desk opens for a session a Device started, on the
/// workspace's Agents page -- made for it, without taking the desk to it,
/// when the workspace has none.
function placeAtDesk(
  demo: DemoContext,
  sessionId: string,
  where: string | null | undefined,
  asWorkspaceAgent: boolean
): void {
  const workspaceId = workspaceHolding(demo, where);
  const ws = demo.state.workspaces.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  if (asWorkspaceAgent) {
    const placed = placeDeviceSession(demo.state.workspaces, ws.id, sessionId, `p-demo-agents-${ws.id}`, true);
    if (placed?.workspaces.find((w) => w.id === ws.id)?.mainSessionId === sessionId) {
      demo.state.workspaces = placed;
      demo.emit("workspaces-synced", { origin: "main", data: placed });
      return;
    }
  }
  const agents = ws.pages.find((p) => p.name === "Agents");
  let data = demo.state.workspaces;
  if (agents) {
    const anchor = layout.allSessionIds(agents.layout)[0];
    data = workspace.updatePageLayout(data, ws.id, agents.id, layout.addTab(agents.layout, anchor, sessionId));
  } else {
    data = workspace.createPage(data, ws.id, `p-demo-agents-${ws.id}`, "Agents", {
      type: "leaf",
      tabs: [sessionId],
      activeTabIndex: 0,
    });
    if (ws.activePageId) data = workspace.switchPage(data, ws.id, ws.activePageId);
  }
  demo.state.workspaces = data;
  demo.emit("workspaces-synced", { origin: "main", data });
}

/// What `kill_session` does: the session ends, then the desk closes its
/// tab -- a workspace's own agent is let go, a page's tab is closed, and
/// a page left with nothing is removed -- and says so.
export function end(demo: DemoContext, sessionId: string): void {
  const { state } = demo;
  state.sessions = state.sessions.filter((s) => s.id !== sessionId);
  delete state.terminals[sessionId];
  demo.emit("session-exited", [sessionId, 0]);

  let data = state.workspaces;
  for (const ws of data.workspaces) {
    if (ws.mainSessionId === sessionId) {
      data = {
        ...data,
        workspaces: data.workspaces.map((w) => (w.id === ws.id ? { ...w, mainSessionId: undefined } : w)),
      };
    }
    for (const page of ws.pages) {
      if (!layout.findLeafPath(page.layout, sessionId)) continue;
      const tree = layout.closeTab(page.layout, sessionId);
      data = tree
        ? workspace.updatePageLayout(data, ws.id, page.id, tree)
        : workspace.removePage(data, ws.id, page.id);
    }
  }
  if (data === state.workspaces) return;
  state.workspaces = data;
  demo.emit("workspaces-synced", { origin: "main", data });
}

// ---- Reading a screen --------------------------------------------------

/// A session's screen as plain text, the way `session_screen` answers:
/// the rows since the screen was last cleared, the last `height` of them.
export function screenText(terminal: DemoTerminal, height = 40): string {
  let text = terminal.output;
  const cleared = text.lastIndexOf("\x1b[2J");
  if (cleared !== -1) text = text.slice(cleared + "\x1b[2J".length);
  text = text.replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]/g, "");
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(/[^\r\n\x08]\x08 \x08/g, "");
  }
  const lines = text.split("\n").map((line) => {
    const row = line.replace(/\r$/, "");
    return row.slice(row.lastIndexOf("\r") + 1);
  });
  return lines.slice(-height).join("\n");
}
