// Quick replies: the verdict says WHETHER, the screen says WHAT.
import { describe, expect, it } from "vitest";
import type { TurnVerdictEntry } from "$lib/agents/turnVerdict";
import {
  isAsking,
  logicalRows,
  quickReplies,
  replyBytes,
  type QuickReplies,
} from "$companion/surfaces/quickReplies";
import { PLAIN_MODES } from "$companion/surfaces/terminalInput";

const ASKING: TurnVerdictEntry = { state: "read", reading: { kind: "asking" } };
const FINISHED: TurnVerdictEntry = { state: "read", reading: { kind: "finished" } };
const PENDING: TurnVerdictEntry = { state: "pending" };
const NO_OPINION: TurnVerdictEntry = { state: "read", reading: null };

/// Claude Code's permission prompt, as it sits at the bottom of a screen.
const PERMISSION = [
  "⏺ Bash(rm -rf .cache/sync-journal)",
  "  ⎿  Waiting for permission…",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for rm commands",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
];

const PROSE_QUESTION = [
  "⏺ The PDF renders from the same template as the HTML invoice.",
  "",
  "⏺ Should the dates follow the customer's locale, or always be ISO 8601?",
  "",
  "> ",
];

const labels = (q: QuickReplies) => q.replies.map((r) => (r.key ? `${r.key} ${r.label}` : r.label));

describe("whether the agent is asking", () => {
  it("is yes when it rang the bell, whatever the verdict", () => {
    expect(isAsking("waiting_for_input", undefined)).toBe(true);
    expect(isAsking("waiting_for_input", FINISHED)).toBe(true);
  });

  it("is yes for a quiet agent the verdict read as asking", () => {
    expect(isAsking("idle", ASKING)).toBe(true);
  });

  it("is no for a quiet agent the verdict read as done, has not read yet, or has no opinion on", () => {
    expect(isAsking("idle", FINISHED)).toBe(false);
    expect(isAsking("idle", PENDING)).toBe(false);
    expect(isAsking("idle", NO_OPINION)).toBe(false);
    expect(isAsking("idle", undefined)).toBe(false);
  });

  it("is no for an agent at work, whatever a stale verdict says", () => {
    expect(isAsking("working", ASKING)).toBe(false);
    expect(isAsking("failed", ASKING)).toBe(false);
  });
});

describe("the replies a verdict opens", () => {
  it("are none while nothing is asked, however much the screen looks like a menu", () => {
    expect(quickReplies({ status: "idle", verdict: FINISHED, screen: PERMISSION })).toEqual({
      shape: null,
      replies: [],
    });
    expect(quickReplies({ status: "working", verdict: undefined, screen: PERMISSION }).replies).toEqual([]);
  });

  it("are a numbered menu's options, each its bare digit", () => {
    const q = quickReplies({ status: "idle", verdict: ASKING, screen: PERMISSION });
    expect(q.shape).toBe("menu");
    expect(labels(q)).toEqual([
      "1 Yes",
      "2 Yes, and don't ask again for rm commands",
      "3 No, and tell Claude what to do differently",
    ]);
    // A digit alone selects; an Enter after it would be left for the
    // next prompt.
    expect(q.replies.map((r) => replyBytes(r.send, PLAIN_MODES))).toEqual(["1", "2", "3"]);
    expect(q.replies.map((r) => r.primary)).toEqual([true, false, false]);
  });

  it("marks the option the agent's cursor is on as the one Enter would take", () => {
    const screen = [" Which store?", "   1. Redis", " ❯ 2. Postgres", "   3. Type something else"];
    const q = quickReplies({ status: "waiting_for_input", verdict: undefined, screen });
    expect(q.replies.map((r) => r.primary)).toEqual([false, true, false]);
  });

  it("folds an option's wrapped label into the option, and reads past the TUI's footer", () => {
    const screen = [
      " Which store?",
      " ❯ 1. Redis — expiry built in,",
      "      one more service to run",
      "   2. Postgres — already deployed",
      "",
      " Enter to select · ↑/↓ to navigate · Esc to cancel",
    ];
    const q = quickReplies({ status: "waiting_for_input", verdict: undefined, screen });
    expect(labels(q)).toEqual(["1 Redis — expiry built in, one more service to run", "2 Postgres — already deployed"]);
  });

  it("reads a menu drawn inside a box", () => {
    const screen = [
      "╭──────────────────────────╮",
      "│ Do you want to proceed?  │",
      "│ ❯ 1. Yes                 │",
      "│   2. No                  │",
      "╰──────────────────────────╯",
    ];
    expect(labels(quickReplies({ status: "waiting_for_input", verdict: undefined, screen }))).toEqual([
      "1 Yes",
      "2 No",
    ]);
  });

  it("is not fooled by a numbered list the agent wrote above its input box", () => {
    const screen = ["⏺ Left to do:", "  1. rotate tokens", "  2. revoke families", "", "> "];
    const q = quickReplies({ status: "idle", verdict: ASKING, screen });
    expect(q.shape).toBe("free-text");
  });

  it("walks an arrow menu from where its cursor is, then presses Enter", () => {
    const screen = [" Pick a model", "   opus", " ❯ sonnet", "   haiku"];
    const q = quickReplies({ status: "waiting_for_input", verdict: undefined, screen });
    expect(q.shape).toBe("arrows");
    expect(labels(q)).toEqual(["opus", "sonnet", "haiku"]);
    expect(q.replies.map((r) => replyBytes(r.send, PLAIN_MODES))).toEqual(["\x1b[A\r", "\r", "\x1b[B\r"]);
    expect(q.replies.map((r) => replyBytes(r.send, { ...PLAIN_MODES, applicationCursorKeysMode: true }))).toEqual([
      "\x1bOA\r",
      "\r",
      "\x1bOB\r",
    ]);
  });

  it("answers a yes/no line as lines, and marks its default", () => {
    const screen = ["$ ./deploy.sh", "overwrite .env.local? (y/n [n])"];
    const q = quickReplies({ status: "waiting_for_input", verdict: undefined, screen });
    expect(q.shape).toBe("yes-no");
    expect(labels(q)).toEqual(["Yes", "No"]);
    expect(q.replies.map((r) => replyBytes(r.send, PLAIN_MODES))).toEqual(["y\r", "n\r"]);
    expect(q.replies.map((r) => r.primary)).toEqual([false, true]);
  });

  it("offers canned words for a question asked in prose, and only then", () => {
    const q = quickReplies({ status: "idle", verdict: ASKING, screen: PROSE_QUESTION });
    expect(q.shape).toBe("free-text");
    expect(labels(q)).toEqual(["Yes", "No", "Continue"]);
    expect(q.replies.every((r) => r.canned)).toBe(true);
    expect(replyBytes(q.replies[2].send, { ...PLAIN_MODES, bracketedPasteMode: true })).toBe(
      "\x1b[200~continue\x1b[201~\r"
    );
    // The same screen, read by the verdict as a finished turn: nothing.
    expect(quickReplies({ status: "idle", verdict: FINISHED, screen: PROSE_QUESTION }).replies).toEqual([]);
  });

  it("offers nothing at a shell prompt that rang the bell -- a failed completion, not a question", () => {
    const q = quickReplies({ status: "waiting_for_input", verdict: undefined, screen: ["demo@workstation ~ % "] });
    expect(q).toEqual({ shape: "shell", replies: [] });
  });
});

describe("a terminal's rows, as lines", () => {
  it("joins a row the terminal wrapped back onto the one before", () => {
    expect(
      logicalRows([
        { text: "   2. Yes, and don't ask again for rm ", wrapped: false },
        { text: "commands in /Users/demo/code   ", wrapped: true },
        { text: "   3. No", wrapped: false },
      ])
    ).toEqual(["   2. Yes, and don't ask again for rm commands in /Users/demo/code", "   3. No"]);
  });

  it("keeps a first row that says it was wrapped, having nothing to join it to", () => {
    expect(logicalRows([{ text: "tail of a line  ", wrapped: true }])).toEqual(["tail of a line"]);
  });
});
