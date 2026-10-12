import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/core/backend", () => ({
  readFileForViewer: vi.fn(),
  writeFileForEditor: vi.fn().mockResolvedValue(undefined),
  setPlanFrontmatterField: vi.fn(),
}));

import * as backend from "$lib/core/backend";
import { svelteSources } from "$lib/sources";
import {
  LEARNED_HEADING,
  adoptBlockedReason,
  adoptMemory,
  MAX_FACT_CHARS,
  MAX_WHY_CHARS,
  appendLearned,
  isMemoryCard,
  learnedMemories,
  memoryBullet,
  parseLearned,
  parseMemoryCard,
  type Memory,
  type MemoryRefusal,
} from "$lib/cards/memoryCard";

const MARKER_START = "<!-- gavin:start -->";
const MARKER_END = "<!-- gavin:end -->";

function file(inner: string, before = "", after = ""): string {
  return `${before}${MARKER_START}\n${inner}${MARKER_END}\n${after}`;
}

describe("isMemoryCard", () => {
  it("is a note carrying the label, matched by slug like a column name", () => {
    expect(isMemoryCard({ kind: "note", labels: ["memory"] })).toBe(true);
    expect(isMemoryCard({ kind: "note", labels: ["bug", " Memory "] })).toBe(true);
  });

  it("is not any other kind, however it is labelled", () => {
    // A task labelled `memory` is WORK about memories -- adopting its
    // prompt into the instructions file would file a to-do as a fact.
    expect(isMemoryCard({ kind: "task", labels: ["memory"] })).toBe(false);
    expect(isMemoryCard({ kind: "plan", labels: ["memory"] })).toBe(false);
    expect(isMemoryCard({ kind: "note", labels: [] })).toBe(false);
    expect(isMemoryCard({ kind: "note", labels: ["memories"] })).toBe(false);
  });
});

describe("parseMemoryCard", () => {
  it("takes the body, never the frontmatter", () => {
    const card = "---\nkind: note\ntitle: The daemon is shared\nlabels: memory\n---\nNever pkill gavin-daemon.\n";
    expect(parseMemoryCard(card)).toEqual({ fact: "Never pkill gavin-daemon.", topics: [], why: null });
  });

  it("reads topics off the frontmatter, not the labels", () => {
    const card = "---\nkind: note\nlabels: memory, bug\ntopics: Daemon, pty\n---\nNever pkill gavin-daemon.\n";
    expect(parseMemoryCard(card)).toEqual({
      fact: "Never pkill gavin-daemon.",
      topics: ["daemon", "pty"],
      why: null,
    });
  });

  it("does not take a topics line from the body for frontmatter", () => {
    const card = "---\nkind: note\n---\ntopics: a\n";
    expect(parseMemoryCard(card)).toEqual({ fact: "topics: a", topics: [], why: null });
  });

  it("names each refusal in a sentence the modal can show", () => {
    const refusal = (body: string) => {
      const r = parseMemoryCard(`---\nkind: note\n---\n${body}`);
      if (!("refuse" in r)) throw new Error("adopted");
      return r.error;
    };
    expect(refusal("")).toBe("This card has no body, so there is no memory to adopt.");
    expect(refusal("Why: because.\n")).toContain("no fact above it");
    expect(refusal("One.\nTwo.\n")).toContain("one fact line plus an optional Why: line");
    expect(refusal(`${"x".repeat(MAX_FACT_CHARS + 1)}\n`)).toContain(`${MAX_FACT_CHARS + 1} characters`);
    expect(refusal(`One.\nWhy: ${"y".repeat(MAX_WHY_CHARS + 1)}\n`)).toContain("more than one fact");
  });

  it("keeps a fact of exactly the limit", () => {
    const fact = "x".repeat(MAX_FACT_CHARS);
    expect(parseMemoryCard(`---\nkind: note\n---\n${fact}\n`)).toEqual({ fact, topics: [], why: null });
  });
});

describe("memoryBullet", () => {
  it("puts topics on the bullet line and the Why under it", () => {
    expect(memoryBullet({ fact: "A fact.", topics: ["a", "b"], why: "because." })).toBe(
      "- A fact. (topics: a, b)\n  Why: because."
    );
    expect(memoryBullet({ fact: "A fact.", topics: [], why: null })).toBe("- A fact.");
  });
});

// The table the daemon's `memory_index::parse_learned` reads too: the
// app writes `### Learned` and the daemon rebuilds its index from it.
describe("against the table it shares with the daemon", () => {
  interface ParseCase {
    name: string;
    section: string;
    memories: Memory[];
  }
  interface BulletCase {
    name: string;
    body: string;
    topics: string | null;
    bullet?: string;
    refuse?: MemoryRefusal;
  }
  const raw = Object.values(
    import.meta.glob("../../../../test-fixtures/learned-memories/cases.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>
  )[0];
  const table = JSON.parse(raw) as { parse: ParseCase[]; bullet: BulletCase[] };

  it("has the table", () => {
    expect(table.parse.length).toBeGreaterThan(5);
    expect(table.bullet.length).toBeGreaterThan(5);
  });

  for (const c of table.parse) {
    it(`reads back: ${c.name}`, () => {
      expect(parseLearned(c.section)).toEqual(c.memories);
    });
  }

  for (const c of table.bullet) {
    it(`adopts: ${c.name}`, () => {
      const front = c.topics === null ? "" : `topics: ${c.topics}\n`;
      const parsed = parseMemoryCard(`---\nkind: note\nlabels: memory\n${front}---\n${c.body}`);
      if (c.refuse) {
        expect("refuse" in parsed && parsed.refuse).toBe(c.refuse);
        return;
      }
      if ("refuse" in parsed) throw new Error(parsed.error);
      const bullet = memoryBullet(parsed);
      expect(bullet).toBe(c.bullet);
      // What Adopt writes is what the daemon will read back.
      expect(parseLearned(bullet)).toEqual([parsed]);
    });
  }
});

describe("learnedMemories", () => {
  it("reads only the block's Learned section", () => {
    const content = file(
      "Guidance.\n- not a memory\n\n### Learned\n\n- One. (topics: a)\n",
      "### Learned\n\n- the human's, outside the block\n\n"
    );
    expect(learnedMemories(content)).toEqual([{ fact: "One.", topics: ["a"], why: null }]);
    expect(learnedMemories("# no block\n")).toEqual([]);
    expect(learnedMemories(file("Guidance.\n"))).toEqual([]);
  });
});

describe("appendLearned", () => {
  it("creates the section inside the block the first time", () => {
    const result = appendLearned(file("## Gavin workspace\n\nRead the PRD.\n"), "- A fact.");
    if ("error" in result) throw new Error(result.error);
    expect(result.content).toBe(
      file("## Gavin workspace\n\nRead the PRD.\n\n### Learned\n\n- A fact.\n")
    );
    // Inside, so agent_setup.rs's merge has something to carry over.
    const inner = result.content.slice(
      result.content.indexOf(MARKER_START),
      result.content.indexOf(MARKER_END)
    );
    expect(inner).toContain(LEARNED_HEADING);
  });

  it("appends under the heading that is already there, once", () => {
    const first = appendLearned(file("Guidance.\n"), "- One.");
    if ("error" in first) throw new Error(first.error);
    const second = appendLearned(first.content, "- Two.");
    if ("error" in second) throw new Error(second.error);
    expect(second.content).toBe(file("Guidance.\n\n### Learned\n\n- One.\n- Two.\n"));
    expect(second.content.match(/### Learned/g)).toHaveLength(1);
  });

  it("leaves the human's own prose above and below the block alone", () => {
    const result = appendLearned(file("Guidance.\n", "# My rules\n\n", "\n## After\n\ntail\n"), "- A fact.");
    if ("error" in result) throw new Error(result.error);
    expect(result.content.startsWith("# My rules\n\n")).toBe(true);
    expect(result.content.endsWith("\n## After\n\ntail\n")).toBe(true);
  });

  it("is a no-op for a fact already adopted", () => {
    const first = appendLearned(file("Guidance.\n"), "- One.");
    if ("error" in first) throw new Error(first.error);
    // Un-Done the card, press Adopt again: the file must not grow a
    // second copy of the same line.
    const again = appendLearned(first.content, "- One.");
    if ("error" in again) throw new Error(again.error);
    expect(again.content).toBe(first.content);
  });

  it("is a no-op for the same fact adopted again with other topics", () => {
    const first = appendLearned(file("Guidance.\n"), "- One. (topics: a)");
    if ("error" in first) throw new Error(first.error);
    const again = appendLearned(first.content, "- One. (topics: a, b)\n  Why: because.");
    if ("error" in again) throw new Error(again.error);
    expect(again.content).toBe(first.content);
  });

  it("refuses a file with no marker block rather than inventing a second home", () => {
    const result = appendLearned("# My rules\n\nKeep tests green.\n", "- A fact.");
    expect("error" in result && result.error).toContain(MARKER_START);
  });

  it("carries a multi-line bullet in whole", () => {
    const result = appendLearned(file("Guidance.\n"), "- A fact.\n  Why: because.");
    if ("error" in result) throw new Error(result.error);
    expect(result.content).toContain("### Learned\n\n- A fact.\n  Why: because.\n");
  });
});

const CARD = { id: "/ws/.gavin-root/plans/memory-daemon.md" };
const INSTRUCTIONS = "/ws/CLAUDE.md";
const BODY = "---\nkind: note\nlabels: memory\n---\nNever pkill gavin-daemon.\n";

function reads(map: Record<string, { content: string; exists?: boolean; truncated?: boolean }>) {
  vi.mocked(backend.readFileForViewer).mockImplementation(async (path: string) => {
    const hit = map[path];
    return {
      content: hit?.content ?? "",
      exists: hit ? (hit.exists ?? true) : false,
      truncated: hit?.truncated ?? false,
    };
  });
}

describe("adoptMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backend.writeFileForEditor).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue(
      "/ws/.gavin-root/plans/done/memory-daemon.md"
    );
  });

  it("writes the fact into the block, then files the card into the done column", async () => {
    reads({ [CARD.id]: { content: BODY }, [INSTRUCTIONS]: { content: file("Guidance.\n") } });
    const result = await adoptMemory(CARD, INSTRUCTIONS, "Shipped");
    expect(result).toEqual({ movedTo: "/ws/.gavin-root/plans/done/memory-daemon.md" });
    expect(backend.writeFileForEditor).toHaveBeenCalledWith(
      INSTRUCTIONS,
      file("Guidance.\n\n### Learned\n\n- Never pkill gavin-daemon.\n")
    );
    // The column NAME the board gave it, not a hardcoded "Done".
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith(CARD.id, "status", "Shipped");
  });

  it("skips the write when the fact is already there but still files the card", async () => {
    reads({
      [CARD.id]: { content: BODY },
      [INSTRUCTIONS]: {
        content: file("Guidance.\n\n### Learned\n\n- Never pkill gavin-daemon.\n"),
      },
    });
    expect(await adoptMemory(CARD, INSTRUCTIONS, "Done")).toEqual({
      movedTo: "/ws/.gavin-root/plans/done/memory-daemon.md",
    });
    expect(backend.writeFileForEditor).not.toHaveBeenCalled();
    expect(backend.setPlanFrontmatterField).toHaveBeenCalled();
  });

  it("files nothing when there is nothing to adopt", async () => {
    // Each of these leaves the card exactly where it was: a card marked
    // done for a memory that never landed is the one outcome worth
    // ruling out, since nothing afterwards would show it.
    reads({ [INSTRUCTIONS]: { content: file("Guidance.\n") } });
    expect(await adoptMemory(CARD, INSTRUCTIONS, "Done")).toEqual({
      error: "The card's file is gone.",
    });

    reads({ [CARD.id]: { content: "---\nkind: note\n---\n" }, [INSTRUCTIONS]: { content: file("G\n") } });
    expect(await adoptMemory(CARD, INSTRUCTIONS, "Done")).toEqual({
      error: "This card has no body, so there is no memory to adopt.",
    });

    reads({ [CARD.id]: { content: BODY } });
    const missing = await adoptMemory(CARD, INSTRUCTIONS, "Done");
    expect("error" in missing && missing.error).toContain("CLAUDE.md doesn't exist yet");

    reads({ [CARD.id]: { content: BODY }, [INSTRUCTIONS]: { content: "# My rules\n" } });
    const noBlock = await adoptMemory(CARD, INSTRUCTIONS, "Done");
    expect("error" in noBlock && noBlock.error).toContain(MARKER_START);

    reads({
      [CARD.id]: { content: BODY },
      [INSTRUCTIONS]: { content: file("G\n"), truncated: true },
    });
    const capped = await adoptMemory(CARD, INSTRUCTIONS, "Done");
    expect("error" in capped && capped.error).toContain("too large");

    expect(backend.writeFileForEditor).not.toHaveBeenCalled();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("writes the topics into the bullet the daemon reads", async () => {
    reads({
      [CARD.id]: { content: "---\nkind: note\nlabels: memory\ntopics: daemon\n---\nNever pkill gavin-daemon.\nWhy: PTYs.\n" },
      [INSTRUCTIONS]: { content: file("Guidance.\n") },
    });
    await adoptMemory(CARD, INSTRUCTIONS, "Done");
    expect(backend.writeFileForEditor).toHaveBeenCalledWith(
      INSTRUCTIONS,
      file("Guidance.\n\n### Learned\n\n- Never pkill gavin-daemon. (topics: daemon)\n  Why: PTYs.\n")
    );
  });

  it("files nothing for a card that is more than one fact", async () => {
    reads({
      [CARD.id]: { content: "---\nkind: note\n---\nOne.\nTwo.\n" },
      [INSTRUCTIONS]: { content: file("G\n") },
    });
    const result = await adoptMemory(CARD, INSTRUCTIONS, "Done");
    expect("error" in result && result.error).toContain("one fact line");
    expect(backend.writeFileForEditor).not.toHaveBeenCalled();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("names the file when the write itself fails", async () => {
    reads({ [CARD.id]: { content: BODY }, [INSTRUCTIONS]: { content: file("G\n") } });
    vi.mocked(backend.writeFileForEditor).mockRejectedValue(new Error("read-only"));
    const result = await adoptMemory(CARD, INSTRUCTIONS, "Done");
    expect("error" in result && result.error).toBe("Couldn't adopt into CLAUDE.md: read-only");
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });
});

// The button lives in a component, which no suite mounts (see
// autoCommitSurfaces.test.ts for why): read the source instead, so a
// handler wired to nothing cannot pass by rendering perfectly.
const SOURCES = svelteSources();

describe("the card detail modal", () => {
  const source = SOURCES["CardDetailModal.svelte"] ?? "";

  it("offers the action only on a card the convention covers", () => {
    // The rule lives in memoryCard.ts; a second copy spelled out here
    // is a second thing to update.
    expect(source).toContain("isMemoryCard(card)");
    expect(source).toContain("{#if isMemory}");
  });

  it("names the workspace's own instructions file in the button", () => {
    expect(source).toContain("Adopt into {instructionsFile}");
    expect(source).toContain("$resolvedAgents(workspaceId).file");
  });

  it("files the card into the board's done column, not a literal", () => {
    expect(source).toContain("doneColumnOf(columns)");
    expect(source).toContain("done.name");
  });

  // The index follows the file: after a successful write, never before,
  // and a miss lands on the modal as a note rather than undoing the adopt.
  it("updates the search index after the adopt, not instead of it", () => {
    const handler = source.slice(source.indexOf("async function handleAdopt"));
    const body = handler.slice(0, handler.indexOf("\n  }"));
    expect(body.indexOf("syncAfterAdopt(adoptRoot)")).toBeGreaterThan(body.indexOf("followMove("));
  });

  it("opens nothing on success", () => {
    const handler = source.slice(source.indexOf("async function handleAdopt"));
    const body = handler.slice(0, handler.indexOf("\n  }"));
    // The slice is the handler, not an empty string that would pass
    // every negative assertion below by default.
    expect(body).toContain("adoptMemory(");
    expect(body).not.toContain("switchWorkspaceView");
    expect(body).not.toContain("openFileInSplit");
    expect(body).not.toContain("onClose");
  });
});

describe("adoptBlockedReason", () => {
  it("is null once there is a root and a done column", () => {
    expect(adoptBlockedReason(true, true)).toBeNull();
  });

  // The instructions file hangs off the root, so a rootless workspace
  // has nothing to adopt INTO.
  it("names the missing root first", () => {
    expect(adoptBlockedReason(false, true)).toContain("no root folder");
    expect(adoptBlockedReason(false, false)).toContain("no root folder");
  });

  // The last column is the human's to call whatever they like, so a
  // board with no columns has nowhere to file the card once the fact is
  // written.
  it("names the missing done column when the root is there", () => {
    expect(adoptBlockedReason(true, false)).toContain("done column");
  });
});
