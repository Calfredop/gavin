import { describe, expect, it } from "vitest";
import type { ForeignMcpServer } from "./backend";
import { foreignMcpServersHash, mcpForeignDecision, mcpForeignNotice } from "./mcpServerTrust";

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
