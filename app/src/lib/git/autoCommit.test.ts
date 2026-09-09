import { describe, it, expect } from "vitest";
import {
  AUTO_COMMIT_BLOCK,
  AUTO_COMMIT_CLOSE,
  AUTO_COMMIT_INSTRUCTION,
  AUTO_COMMIT_OPEN,
  DEFAULT_AUTO_COMMIT,
  autoCommitAppliesTo,
  autoCommitFromSelect,
  autoCommitOptions,
  autoCommitToSelect,
  hasAutoCommit,
  normalizeAutoCommit,
  resolveAutoCommit,
  setAutoCommitInBody,
  setAutoCommitInFile,
} from "$lib/git/autoCommit";

const card = (body: string) => `---\nkind: task\ntitle: A\nstatus: To Do\n---\n${body}`;

describe("the block itself", () => {
  it("fences the instruction between markers that render as nothing", () => {
    expect(AUTO_COMMIT_BLOCK).toBe(
      `${AUTO_COMMIT_OPEN}\n${AUTO_COMMIT_INSTRUCTION}\n${AUTO_COMMIT_CLOSE}`
    );
    // HTML comments: the human reads the sentence in the modal's
    // preview and in the file, and never sees the fence.
    expect(AUTO_COMMIT_OPEN.startsWith("<!--")).toBe(true);
    expect(AUTO_COMMIT_CLOSE.startsWith("<!--")).toBe(true);
  });

  it("tells the agent the shared-tree rule, which is the trap here", () => {
    expect(AUTO_COMMIT_INSTRUCTION).toContain("only the files you touched");
    expect(AUTO_COMMIT_INSTRUCTION).toContain("git add -A");
    expect(AUTO_COMMIT_INSTRUCTION).toContain("Do not push");
  });

  it("is a single paragraph, so it cannot break a card's markdown", () => {
    expect(AUTO_COMMIT_INSTRUCTION).not.toContain("\n");
  });
});

describe("hasAutoCommit", () => {
  it("finds the block wherever it sits in the body", () => {
    expect(hasAutoCommit(AUTO_COMMIT_BLOCK)).toBe(true);
    expect(hasAutoCommit(`do the thing\n\n${AUTO_COMMIT_BLOCK}`)).toBe(true);
    expect(hasAutoCommit(`${AUTO_COMMIT_BLOCK}\n\ndo the thing`)).toBe(true);
  });

  it("is false for a card that never asked for it", () => {
    expect(hasAutoCommit("")).toBe(false);
    expect(hasAutoCommit(null)).toBe(false);
    expect(hasAutoCommit(undefined)).toBe(false);
    expect(hasAutoCommit("commit this when you are done")).toBe(false);
  });

  it("still reads as on when the sentence between the markers was edited", () => {
    // The fence is the state, not the wording. Someone who rewrites the
    // instruction to suit their project has not turned the flag off, and
    // the toggle must not silently re-add a second block beside theirs.
    expect(hasAutoCommit(`${AUTO_COMMIT_OPEN}\nsquash and commit\n${AUTO_COMMIT_CLOSE}`)).toBe(true);
  });

  it("ignores a lone marker, which is a half-deleted block, not a flag", () => {
    expect(hasAutoCommit(AUTO_COMMIT_OPEN)).toBe(false);
    expect(hasAutoCommit(AUTO_COMMIT_CLOSE)).toBe(false);
  });
});

describe("setAutoCommitInBody", () => {
  it("appends the block after the prompt, one blank line down", () => {
    expect(setAutoCommitInBody("Do the thing.", true)).toBe(
      `Do the thing.\n\n${AUTO_COMMIT_BLOCK}`
    );
  });

  it("is the whole body when there is no prompt yet", () => {
    expect(setAutoCommitInBody("", true)).toBe(AUTO_COMMIT_BLOCK);
    expect(setAutoCommitInBody("   \n\n ", true)).toBe(AUTO_COMMIT_BLOCK);
  });

  it("is idempotent, and keeps a hand-edited block as written", () => {
    const edited = `Do the thing.\n\n${AUTO_COMMIT_OPEN}\nsquash first\n${AUTO_COMMIT_CLOSE}`;
    expect(setAutoCommitInBody(edited, true)).toBe(edited);
    const once = setAutoCommitInBody("Do the thing.", true);
    expect(setAutoCommitInBody(once, true)).toBe(once);
  });

  it("takes the block back off and leaves the prompt exactly as it was", () => {
    const body = "Do the thing.\n\n- [ ] step one\n";
    expect(setAutoCommitInBody(setAutoCommitInBody(body, true), false)).toBe(body.trim());
  });

  it("removes a block the human moved into the middle without welding paragraphs", () => {
    const body = `intro\n\n${AUTO_COMMIT_BLOCK}\n\noutro`;
    expect(setAutoCommitInBody(body, false)).toBe("intro\n\noutro");
  });

  it("removes every copy, so a duplicated block cannot survive an off", () => {
    const body = `a\n\n${AUTO_COMMIT_BLOCK}\n\nb\n\n${AUTO_COMMIT_BLOCK}`;
    expect(setAutoCommitInBody(body, false)).toBe("a\n\nb");
  });

  it("leaves a body that never had the block alone", () => {
    expect(setAutoCommitInBody("Do the thing.", false)).toBe("Do the thing.");
  });
});

describe("setAutoCommitInFile", () => {
  it("splices the body and does not touch a byte of the frontmatter", () => {
    const next = setAutoCommitInFile(card("Do the thing.\n"), true);
    expect(next).toBe(card(`Do the thing.\n\n${AUTO_COMMIT_BLOCK}\n`));
    expect(next.startsWith("---\nkind: task\ntitle: A\nstatus: To Do\n---\n")).toBe(true);
  });

  it("round-trips a card back to what it was", () => {
    const original = card("Do the thing.\n");
    expect(setAutoCommitInFile(setAutoCommitInFile(original, true), false)).toBe(original);
  });

  it("never leaves a frontmatter line looking like body text", () => {
    // `status: To Do` is not a paragraph, and a splice that lost the
    // closing --- would turn the whole card into prose on the board.
    const next = setAutoCommitInFile(card(""), true);
    expect(next).toBe(card(`${AUTO_COMMIT_BLOCK}\n`));
  });

  it("ends the file with exactly one newline, on and off", () => {
    const on = setAutoCommitInFile(card("Do the thing.\n"), true);
    expect(on.endsWith(`${AUTO_COMMIT_CLOSE}\n`)).toBe(true);
    expect(on.endsWith("\n\n")).toBe(false);
    const off = setAutoCommitInFile(on, false);
    expect(off.endsWith("\n")).toBe(true);
    expect(off.endsWith("\n\n")).toBe(false);
  });

  it("handles a file with no frontmatter at all", () => {
    expect(setAutoCommitInFile("Do the thing.\n", true)).toBe(
      `Do the thing.\n\n${AUTO_COMMIT_BLOCK}\n`
    );
  });

  it("refuses a file whose frontmatter never closes, rather than guessing", () => {
    // Every line is still frontmatter as far as any parser is
    // concerned; appending a paragraph would silently invent a body.
    const broken = "---\ntitle: A\nDo the thing.\n";
    expect(setAutoCommitInFile(broken, true)).toBe(broken);
    expect(setAutoCommitInFile(broken, false)).toBe(broken);
  });
});

describe("autoCommitAppliesTo", () => {
  it("is task and plan work only", () => {
    expect(autoCommitAppliesTo("task")).toBe(true);
    expect(autoCommitAppliesTo("plan")).toBe(true);
  });

  it("is never a note: nothing ever runs one, so the line would be dead text", () => {
    expect(autoCommitAppliesTo("note")).toBe(false);
    expect(autoCommitAppliesTo(null)).toBe(false);
  });
});

describe("normalizeAutoCommit", () => {
  it("believes a real boolean", () => {
    expect(normalizeAutoCommit(true)).toBe(true);
    expect(normalizeAutoCommit(false)).toBe(false);
  });

  it("reads anything else out of config.json as no setting at all", () => {
    // Null rather than the default, so a workspace with nothing of its
    // own still falls through to the app-wide value instead of jumping
    // past it.
    expect(normalizeAutoCommit(undefined)).toBe(null);
    expect(normalizeAutoCommit(null)).toBe(null);
    expect(normalizeAutoCommit("yes")).toBe(null);
    expect(normalizeAutoCommit(1)).toBe(null);
  });
});

describe("resolveAutoCommit", () => {
  it("lets the workspace win over the app, either way round", () => {
    expect(resolveAutoCommit(true, false)).toBe(true);
    expect(resolveAutoCommit(false, true)).toBe(false);
  });

  it("falls through to the app-wide setting when the workspace has none", () => {
    expect(resolveAutoCommit(undefined, true)).toBe(true);
    expect(resolveAutoCommit(undefined, false)).toBe(false);
  });

  it("lands on gavin's default when nothing has been chosen", () => {
    expect(resolveAutoCommit(undefined, undefined)).toBe(DEFAULT_AUTO_COMMIT);
    expect(resolveAutoCommit(null, null)).toBe(DEFAULT_AUTO_COMMIT);
  });

  it("defaults to OFF — committing is the human's call (PRD)", () => {
    expect(DEFAULT_AUTO_COMMIT).toBe(false);
  });
});

describe("the picker's rows", () => {
  it("names what the inherit row currently inherits", () => {
    expect(autoCommitOptions(false)[0]).toEqual({ value: "", label: "Default (off)" });
    expect(autoCommitOptions(true)[0]).toEqual({ value: "", label: "Default (on)" });
  });

  it("offers inherit, on and off in that order", () => {
    expect(autoCommitOptions(false).map((o) => o.value)).toEqual(["", "on", "off"]);
  });

  it("round-trips a stored value through the select and back", () => {
    for (const stored of [true, false, null] as const) {
      expect(autoCommitFromSelect(autoCommitToSelect(stored))).toBe(stored);
    }
  });

  it("reads an absent setting, and junk, as the inherit row", () => {
    expect(autoCommitToSelect(undefined)).toBe("");
    expect(autoCommitToSelect("nonsense" as unknown as boolean)).toBe("");
    expect(autoCommitFromSelect("nonsense")).toBe(null);
  });
});
