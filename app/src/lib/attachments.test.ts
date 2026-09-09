import { describe, it, expect } from "vitest";
import {
  addAttachment,
  attachmentFromPick,
  attachmentName,
  attachmentPromptBlock,
  formatAttachments,
  missingAttachmentReason,
  parseAttachments,
  removeAttachment,
  resolvedAttachmentPaths,
  withheldAttachmentPaths,
  type AttachmentLocation,
  type AttachmentStatus,
} from "$lib/attachments";

const status = (
  path: string,
  exists: boolean,
  absolutePath: string | null = `/ws/${path}`,
  location: AttachmentLocation = "root",
  refusedReason: string | null = null
): AttachmentStatus => ({ path, absolutePath, exists, location, refusedReason });

const refused = (path: string, reason: string): AttachmentStatus =>
  status(path, false, null, "refused", reason);

const outside = (path: string, absolutePath: string, exists = true): AttachmentStatus =>
  status(path, exists, absolutePath, "outside");

describe("parseAttachments", () => {
  it("splits on commas and trims, exactly like the daemon's parser", () => {
    expect(parseAttachments("docs/spec.md,  /Users/x/shot.png , ")).toEqual([
      "docs/spec.md",
      "/Users/x/shot.png",
    ]);
  });

  it("treats absent, empty and comma-only lines as no attachments", () => {
    expect(parseAttachments(null)).toEqual([]);
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments("")).toEqual([]);
    expect(parseAttachments("  ,  ,")).toEqual([]);
  });

  it("keeps junk, so a broken path reaches the chip instead of vanishing", () => {
    expect(parseAttachments("../outside.md")).toEqual(["../outside.md"]);
  });
});

describe("formatAttachments", () => {
  it("round-trips through parse", () => {
    const paths = ["docs/spec.md", "/Users/x/shot.png"];
    expect(parseAttachments(formatAttachments(paths))).toEqual(paths);
  });

  it("is empty for an empty list, which is what clears the line", () => {
    expect(formatAttachments([])).toBe("");
  });
});

describe("add/removeAttachment", () => {
  it("appends, and ignores a path already on the card", () => {
    expect(addAttachment(["a.md"], "b.md")).toEqual(["a.md", "b.md"]);
    expect(addAttachment(["a.md"], "a.md")).toEqual(["a.md"]);
    expect(addAttachment(["a.md"], "   ")).toEqual(["a.md"]);
  });

  it("removes by exact stored path", () => {
    expect(removeAttachment(["a.md", "b.md"], "a.md")).toEqual(["b.md"]);
    expect(removeAttachment(["a.md"], "nope.md")).toEqual(["a.md"]);
  });
});

describe("attachmentFromPick", () => {
  it("relativises a file inside the workspace root", () => {
    expect(attachmentFromPick("/ws", "/ws/docs/spec.md")).toBe("docs/spec.md");
  });

  it("keeps a file outside the root absolute — that is the common case", () => {
    expect(attachmentFromPick("/ws", "/Users/x/Desktop/shot.png")).toBe(
      "/Users/x/Desktop/shot.png"
    );
  });

  it("does not mistake a sibling directory for the root", () => {
    expect(attachmentFromPick("/a/proj", "/a/proj-old/spec.md")).toBe("/a/proj-old/spec.md");
  });
});

describe("attachmentName", () => {
  it("is the file name alone; the path is the tooltip's job", () => {
    expect(attachmentName("docs/deep/spec.md")).toBe("spec.md");
    expect(attachmentName("/Users/x/shot.png")).toBe("shot.png");
    expect(attachmentName("spec.md")).toBe("spec.md");
  });
});

describe("attachmentPromptBlock", () => {
  it("lists absolute paths one per line and says to read them first", () => {
    const block = attachmentPromptBlock(["/ws/docs/spec.md", "/Users/x/shot.png"]);
    expect(block).toContain("read them before you start");
    expect(block).toContain("- /ws/docs/spec.md");
    expect(block).toContain("- /Users/x/shot.png");
  });

  it("is empty with no attachments at all, so composers can concatenate blindly", () => {
    expect(attachmentPromptBlock([])).toBe("");
    expect(attachmentPromptBlock([], [])).toBe("");
  });

  it("names withheld entries in a separate note, without handing over a path to read", () => {
    const block = attachmentPromptBlock([], ["~/Desktop/shot.png"]);
    expect(block).toContain("~/Desktop/shot.png");
    expect(block).toContain("gavin");
    expect(block).not.toContain("read them before you start");
  });

  it("carries both sections when some attachments are readable and some withheld", () => {
    const block = attachmentPromptBlock(["/ws/docs/spec.md"], ["~/Desktop/shot.png"]);
    expect(block).toContain("- /ws/docs/spec.md");
    expect(block).toContain("~/Desktop/shot.png");
  });
});

describe("resolvedAttachmentPaths", () => {
  it("hands back the absolute paths, in card order", () => {
    expect(
      resolvedAttachmentPaths([status("docs/a.md", true), status("docs/b.md", true)])
    ).toEqual(["/ws/docs/a.md", "/ws/docs/b.md"]);
  });

  it("hands back an extra-context path exactly like a root one", () => {
    expect(
      resolvedAttachmentPaths([status("shared/x.md", true, "/ctx/shared/x.md", "extraContext")])
    ).toEqual(["/ctx/shared/x.md"]);
  });

  it("drops what did not resolve — the run gate refuses first", () => {
    expect(
      resolvedAttachmentPaths([status("gone.md", false), refused("../x.md", "contains a `..` component")])
    ).toEqual([]);
  });

  it("drops an outside entry even though it resolved and exists — it is withheld, not read", () => {
    expect(resolvedAttachmentPaths([outside("~/Desktop/shot.png", "/Users/x/Desktop/shot.png")])).toEqual(
      []
    );
  });
});

describe("withheldAttachmentPaths", () => {
  it("names an existing outside entry by its raw card text", () => {
    expect(
      withheldAttachmentPaths([outside("~/Desktop/shot.png", "/Users/x/Desktop/shot.png")])
    ).toEqual(["~/Desktop/shot.png"]);
  });

  it("is empty for root/extraContext entries and for an outside entry that does not exist", () => {
    expect(
      withheldAttachmentPaths([
        status("docs/a.md", true),
        status("shared/x.md", true, "/ctx/shared/x.md", "extraContext"),
        outside("~/gone.png", "/Users/x/gone.png", false),
      ])
    ).toEqual([]);
  });
});

describe("missingAttachmentReason", () => {
  it("is null when every attachment is there, and when there are none", () => {
    expect(missingAttachmentReason([])).toBeNull();
    expect(missingAttachmentReason([status("docs/a.md", true)])).toBeNull();
  });

  it("is null for an outside entry that exists — withheld is not blocked", () => {
    expect(
      missingAttachmentReason([outside("~/Desktop/shot.png", "/Users/x/Desktop/shot.png")])
    ).toBeNull();
  });

  it("names the missing file rather than saying one is missing", () => {
    const reason = missingAttachmentReason([status("docs/a.md", true), status("gone.md", false)]);
    expect(reason).toContain("gone.md");
    expect(reason).not.toContain("docs/a.md");
    expect(reason).toContain("Attachment not found");
  });

  it("names all of them, plural, when more than one is gone", () => {
    const reason = missingAttachmentReason([status("a.md", false), status("b.md", false)]);
    expect(reason).toContain("Attachments not found");
    expect(reason).toContain("a.md");
    expect(reason).toContain("b.md");
  });

  it("gives a refused entry its own message naming why, distinct from a missing one", () => {
    const reason = missingAttachmentReason([
      refused("~/.ssh/id_rsa", "lies inside ~/.ssh, which gavin refuses to hand an agent"),
    ]);
    expect(reason).toContain("Attachment refused");
    expect(reason).toContain("~/.ssh/id_rsa");
    expect(reason).toContain("gavin refuses to hand an agent");
  });

  it("reports a refused entry ahead of an ordinary missing one, so the loud reason wins", () => {
    const reason = missingAttachmentReason([
      status("gone.md", false),
      refused("../x.md", "contains a `..` component"),
    ]);
    expect(reason).toContain("Attachment refused");
    expect(reason).toContain("../x.md");
  });
});
