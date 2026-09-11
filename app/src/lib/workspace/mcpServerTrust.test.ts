import { describe, expect, it } from "vitest";
import type { ForeignMcpServer, IntegrationResult } from "$lib/core/backend";
import {
  foreignMcpServersHash,
  integrationNote,
  mcpForeignDecision,
  mcpForeignNotice,
} from "$lib/workspace/mcpServerTrust";

const EVIL: ForeignMcpServer = { name: "evil", command: "/bin/sh", args: ["-c", "curl x"] };
const OTHER: ForeignMcpServer = { name: "other", command: "/bin/other", args: [] };

describe("foreignMcpServersHash", () => {
  it("hashes nothing when there is nothing foreign", () => {
    expect(foreignMcpServersHash([])).toBe("");
  });

  it("is order-independent, since the set is what matters", () => {
    expect(foreignMcpServersHash([EVIL, OTHER])).toBe(foreignMcpServersHash([OTHER, EVIL]));
  });

  it("changes when the set changes", () => {
    expect(foreignMcpServersHash([EVIL])).not.toBe(foreignMcpServersHash([EVIL, OTHER]));
    expect(foreignMcpServersHash([EVIL])).not.toBe(
      foreignMcpServersHash([{ ...EVIL, command: "/bin/bash" }])
    );
  });
});

describe("mcpForeignDecision", () => {
  it("has nothing to decide when the set is empty", () => {
    expect(mcpForeignDecision([], { hash: "anything", action: "keep" })).toBeUndefined();
  });

  it("is undecided with no recorded choice", () => {
    expect(mcpForeignDecision([EVIL], undefined)).toBeUndefined();
    expect(mcpForeignDecision([EVIL], null)).toBeUndefined();
  });

  it("replays the recorded action for exactly the set it was recorded for", () => {
    const choice = { hash: foreignMcpServersHash([EVIL]), action: "isolate" as const };
    expect(mcpForeignDecision([EVIL], choice)).toBe("isolate");
  });

  it("goes back to undecided the moment the set changes", () => {
    // AG-07: a decision the human was not shown must never be replayed
    // — an edited mcp_file, a git pull, a colleague's change to the
    // target all change the digest.
    const choice = { hash: foreignMcpServersHash([EVIL]), action: "keep" as const };
    expect(mcpForeignDecision([EVIL, OTHER], choice)).toBeUndefined();
    expect(mcpForeignDecision([OTHER], choice)).toBeUndefined();
  });
});

describe("mcpForeignNotice", () => {
  it("names the count correctly for one and several", () => {
    expect(mcpForeignNotice([])).toBe("");
    expect(mcpForeignNotice([EVIL])).toBe("This file already runs a server gavin did not add.");
    expect(mcpForeignNotice([EVIL, OTHER])).toBe("This file already runs 2 servers gavin did not add.");
  });
});

describe("integrationNote", () => {
  const ROOT = "/w";
  const base: IntegrationResult = { written: [], skipped: [], replaced: [] };

  it("lists what it wrote and stays quiet about everything else", () => {
    expect(integrationNote({ ...base, written: ["/w/CLAUDE.md", "/w/.mcp.json"] }, ROOT)).toBe(
      "Wrote: CLAUDE.md, .mcp.json — re-run any time to update."
    );
  });

  // The failure this whole clause exists for: a run put a stale embedded
  // template back over a skill the workspace had edited and said nothing,
  // so the only trace was an unexplained diff in a shared checkout. The
  // note has to name the file AND where the displaced copy went, or the
  // human learns nothing they can act on.
  it("names a displaced file and the copy that was kept", () => {
    expect(
      integrationNote(
        {
          ...base,
          written: ["/w/.claude/skills/gavin-develop/SKILL.md"],
          replaced: [
            [
              "/w/.claude/skills/gavin-develop/SKILL.md",
              "/w/.claude/skills/gavin-develop/SKILL.md.replaced",
            ],
          ],
        },
        ROOT
      )
    ).toBe(
      "Wrote: .claude/skills/gavin-develop/SKILL.md. " +
        "Replaced .claude/skills/gavin-develop/SKILL.md, keeping your copy as " +
        ".claude/skills/gavin-develop/SKILL.md.replaced — re-run any time to update."
    );
  });

  it("says nothing about replacements on a re-run that displaced nothing", () => {
    const note = integrationNote({ ...base, written: ["/w/CLAUDE.md"] }, ROOT);
    expect(note).not.toContain("Replaced");
  });

  it("still reports skips, and reports them after the replacements", () => {
    const note = integrationNote(
      {
        written: ["/w/CLAUDE.md"],
        skipped: [["MCP config", "unreadable"]],
        replaced: [["/w/a", "/w/a.replaced"]],
      },
      ROOT
    );
    expect(note).toBe(
      "Wrote: CLAUDE.md. Replaced a, keeping your copy as a.replaced. " +
        "Skipped: MCP config — re-run any time to update."
    );
  });

  // A workspace with no root cannot have been set up; trimming against
  // "" would eat the leading separator of every path instead.
  it("leaves paths absolute when there is no root to trim", () => {
    expect(integrationNote({ ...base, written: ["/w/CLAUDE.md"] }, undefined)).toBe(
      "Wrote: /w/CLAUDE.md — re-run any time to update."
    );
  });
});
