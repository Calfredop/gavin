import { describe, expect, it } from "vitest";
import type { HumanItem } from "$lib/core/gavin";
import { DEFAULT_CLEAN_STALE } from "$lib/agents/actionPromptDefaults";
import { actionPromptById } from "$lib/agents/actionPrompts";
import {
  CLEAN_LABEL,
  cleanBlocker,
  cleanConfirm,
  cleanEntries,
  cleanItemCount,
  cleanTip,
  composeCleanPrompt,
  itemsBlock,
  type CleanEntry,
} from "$lib/decisions/cleanStale";

function item(over: Partial<HumanItem> = {}): HumanItem {
  return {
    kind: "decision",
    text: "Which serializer?",
    done: false,
    options: [],
    latest: null,
    state: "open",
    lineText: "Decision: Which serializer?",
    lineIndex: 4,
    ...over,
  };
}

const card = (path: string, items: HumanItem[]): CleanEntry => ({
  cardPath: path,
  title: path.split("/").pop()!.replace(".md", ""),
  items,
});

describe("cleanEntries", () => {
  it("drops cards with nothing written down to close", () => {
    const entries = cleanEntries([card("/p/a.md", [item()]), card("/p/b.md", [])]);
    expect(entries.map((e) => e.cardPath)).toEqual(["/p/a.md"]);
  });

  it("strips every field but the three the prompt reads", () => {
    const [entry] = cleanEntries([{ ...card("/p/a.md", [item()]), sessionId: "s1" } as CleanEntry]);
    expect(Object.keys(entry).sort()).toEqual(["cardPath", "items", "title"]);
  });
});

describe("cleanBlocker", () => {
  const entries = [card("/p/a.md", [item()])];

  it("says the version gate before anything else", () => {
    expect(
      cleanBlocker({ kind: "decisions", entries: [], itemsBlockedReason: "daemon too old", hasRoot: false })
    ).toBe("daemon too old");
  });

  it("needs a root folder to launch in", () => {
    expect(cleanBlocker({ kind: "decisions", entries, itemsBlockedReason: null, hasRoot: false })).toMatch(
      /no root folder/
    );
  });

  it("names the tab's own kind when nothing is open", () => {
    expect(cleanBlocker({ kind: "decisions", entries: [], itemsBlockedReason: null, hasRoot: true })).toBe(
      "No card has an open decision"
    );
    expect(cleanBlocker({ kind: "tests", entries: [], itemsBlockedReason: null, hasRoot: true })).toBe(
      "No card has a human test owed"
    );
  });

  it("is null when there is something to clean", () => {
    expect(cleanBlocker({ kind: "tests", entries, itemsBlockedReason: null, hasRoot: true })).toBeNull();
  });
});

describe("cleanTip", () => {
  it("counts items and cards", () => {
    const entries = [card("/p/a.md", [item(), item({ lineIndex: 5 })]), card("/p/b.md", [item()])];
    expect(cleanItemCount(entries)).toBe(3);
    expect(cleanTip("decisions", entries)).toMatch(/3 open on 2 cards$/);
    expect(cleanTip("tests", [card("/p/a.md", [item({ kind: "test" })])])).toMatch(/the test .* 1 open on 1 card$/);
  });
});

describe("itemsBlock", () => {
  it("lists each item under its card with its options and last outcome", () => {
    const block = itemsBlock("tests", [
      card("/p/a.md", [
        item({
          kind: "test",
          text: "Button reads Save",
          state: "failed",
          latest: "Result (2026-10-01): failed — says OK",
        }),
      ]),
    ]);
    expect(block).toBe(
      [
        "Open `Human test:` items:",
        "",
        '- /p/a.md ("a")',
        "  - Human test: Button reads Save",
        "    Result (2026-10-01): failed — says OK",
      ].join("\n")
    );
  });

  it("carries a decision's options", () => {
    const block = itemsBlock("decisions", [card("/p/a.md", [item({ options: ["serde", "bincode"] })])]);
    expect(block).toContain("  - Decision: Which serializer?\n    Options: serde | bincode");
  });
});

describe("composeCleanPrompt", () => {
  it("fills every placeholder of the shipped template", () => {
    const prompt = composeCleanPrompt("decisions", [card("/p/a.md", [item()])], DEFAULT_CLEAN_STALE, "NAME FIRST");
    expect(prompt.startsWith("NAME FIRST")).toBe(true);
    expect(prompt).toContain("The Decisions tab lists the `Decision:` items");
    expect(prompt).toContain('- /p/a.md ("a")');
    expect(prompt).toContain("Closed as stale (YYYY-MM-DD)");
    expect(prompt).not.toMatch(/\{\{/);
  });

  it("names the Review tab for tests", () => {
    const prompt = composeCleanPrompt("tests", [card("/p/a.md", [item({ kind: "test" })])], DEFAULT_CLEAN_STALE, "");
    expect(prompt).toMatch(/^The Review tab lists the `Human test:` items/);
  });

  it("closes items with a line no outcome parser reads as an answer or a result", () => {
    // `Answer (` / `Result (` would record an answer the human never
    // gave, or a test nobody ran (crates/daemon/src/gavin.rs outcome_state).
    expect(DEFAULT_CLEAN_STALE).not.toMatch(/`(Answer|Result) \(/);
  });

  it("is a tweakable action prompt declaring every placeholder it uses", () => {
    const prompt = actionPromptById("action:clean-stale");
    expect(prompt?.defaultBody).toBe(DEFAULT_CLEAN_STALE);
    const declared = new Set(prompt!.params.map((p) => p.name));
    for (const name of DEFAULT_CLEAN_STALE.matchAll(/\{\{(\w+)\}\}/g)) expect(declared.has(name[1])).toBe(true);
  });
});

describe("cleanConfirm", () => {
  it("says how much the agent will read, and names the action on the button", () => {
    const entries = [card("/p/a.md", [item(), item({ lineIndex: 5 })]), card("/p/b.md", [item()])];
    const confirm = cleanConfirm("decisions", entries);
    expect(confirm.title).toBe("Clean stale decisions?");
    expect(confirm.lines[0]).toContain("3 open decisions on 2 cards");
    expect(confirm.confirmLabel).not.toBe("OK");
  });

  it("speaks of tests on the Review tab", () => {
    const confirm = cleanConfirm("tests", [card("/p/a.md", [item({ kind: "test" })])]);
    expect(confirm.title).toBe("Clean stale tests?");
    expect(confirm.lines[0]).toContain("1 open human test on 1 card");
  });
});

describe("CLEAN_LABEL", () => {
  it("names both tabs' buttons", () => {
    expect(CLEAN_LABEL).toEqual({ decisions: "Clean stale decisions", tests: "Clean stale tests" });
  });
});
