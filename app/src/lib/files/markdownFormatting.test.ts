import { describe, it, expect } from "vitest";
import {
  applyChanges,
  applyFormat,
  chordToKeyName,
  FORMAT_GROUPS,
  type FormatAction,
  type FormatSelection,
} from "$lib/files/markdownFormatting";

/// Runs an action and returns the text it produced plus the selection,
/// with the selection ALSO checked against the new document: an offset
/// past the end, or one that does not sit where the test says it does,
/// would be a caret landing somewhere else in the app.
function run(action: FormatAction, doc: string, anchor: number, head = anchor) {
  const result = applyFormat(action, doc, { anchor, head });
  const text = applyChanges(doc, result.changes);
  const { selection } = result;
  expect(selection.anchor).toBeGreaterThanOrEqual(0);
  expect(selection.head).toBeGreaterThanOrEqual(0);
  expect(selection.anchor).toBeLessThanOrEqual(text.length);
  expect(selection.head).toBeLessThanOrEqual(text.length);
  const selected = text.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head));
  return { text, selection, selected };
}

function cursor(pos: number): FormatSelection {
  return { anchor: pos, head: pos };
}

describe("the bar's table", () => {
  it("lists every action exactly once", () => {
    const actions = FORMAT_GROUPS.flat().map((b) => b.action);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions.sort()).toEqual(
      (
        [
          "bold",
          "italic",
          "strikethrough",
          "code",
          "link",
          "heading-1",
          "heading-2",
          "heading-3",
          "bullet-list",
          "numbered-list",
          "task-list",
          "quote",
          "code-block",
          "rule",
          "table",
        ] as FormatAction[]
      ).sort()
    );
  });

  it("gives every chord a distinct key, so no two buttons fight over one", () => {
    const keys = FORMAT_GROUPS.flat()
      .filter((b) => b.chord)
      .map((b) => chordToKeyName(b.chord!));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names chords the way CodeMirror's keymap reads them", () => {
    expect(chordToKeyName({ key: "b" })).toBe("Mod-b");
    expect(chordToKeyName({ key: "x", shift: true })).toBe("Mod-Shift-x");
    expect(chordToKeyName({ key: "k", alt: true, shift: true })).toBe("Mod-Alt-Shift-k");
  });
});

describe("inline marks", () => {
  it("wraps a selection and keeps it selected", () => {
    const r = run("bold", "make this bold", 5, 9);
    expect(r.text).toBe("make **this** bold");
    expect(r.selected).toBe("this");
  });

  it("keeps a backwards selection backwards", () => {
    const r = run("bold", "make this bold", 9, 5);
    expect(r.text).toBe("make **this** bold");
    expect(r.selection).toEqual({ anchor: 11, head: 7 });
  });

  it("unwraps a selection that includes the markers", () => {
    const r = run("bold", "make **this** bold", 5, 13);
    expect(r.text).toBe("make this bold");
    expect(r.selected).toBe("this");
  });

  it("unwraps a selection the markers hug", () => {
    const r = run("bold", "make **this** bold", 7, 11);
    expect(r.text).toBe("make this bold");
    expect(r.selected).toBe("this");
  });

  it("leaves whitespace at the selection's ends outside the markers", () => {
    const r = run("bold", "make this bold", 4, 10);
    expect(r.text).toBe("make **this** bold");
    expect(r.selected).toBe("this");
  });

  it("wraps the word the caret sits in and keeps the caret on its character", () => {
    const r = run("bold", "make this bold", 7);
    expect(r.text).toBe("make **this** bold");
    expect(r.selection).toEqual(cursor(9));
  });

  it("wraps the word the caret touches at its end", () => {
    const r = run("bold", "make this bold", 9);
    expect(r.text).toBe("make **this** bold");
    expect(r.selection).toEqual(cursor(11));
  });

  it("unwraps the wrapped word the caret sits in", () => {
    const r = run("bold", "make **this** bold", 9);
    expect(r.text).toBe("make this bold");
    expect(r.selection).toEqual(cursor(7));
  });

  it("inserts an empty pair on whitespace with the caret between them", () => {
    const r = run("bold", "make  bold", 5);
    expect(r.text).toBe("make **** bold");
    expect(r.selection).toEqual(cursor(7));
  });

  it("takes an empty pair back when the caret sits inside it", () => {
    const r = run("bold", "make **** bold", 7);
    expect(r.text).toBe("make  bold");
    expect(r.selection).toEqual(cursor(5));
  });

  it("works at the very start and end of the document", () => {
    expect(run("bold", "word", 0).text).toBe("**word**");
    expect(run("bold", "word", 4).text).toBe("**word**");
    expect(run("bold", "", 0)).toMatchObject({ text: "****", selection: cursor(2) });
  });

  it("uses underscores for italic, tildes for strikethrough and backticks for code", () => {
    expect(run("italic", "a word here", 2, 6).text).toBe("a _word_ here");
    expect(run("strikethrough", "a word here", 2, 6).text).toBe("a ~~word~~ here");
    expect(run("code", "a word here", 2, 6).text).toBe("a `word` here");
  });

  it("does not mistake bold's stars for italic", () => {
    const r = run("italic", "**word**", 2, 6);
    expect(r.text).toBe("**_word_**");
  });

  it("counts letters in any script as a word", () => {
    const r = run("bold", "mañana über", 2);
    expect(r.text).toBe("**mañana** über");
  });
});

describe("links", () => {
  it("wraps a selection and selects the url placeholder", () => {
    const r = run("link", "see the docs", 8, 12);
    expect(r.text).toBe("see the [docs](url)");
    expect(r.selected).toBe("url");
  });

  it("wraps a selected address and selects the text placeholder instead", () => {
    const r = run("link", "see https://example.com now", 4, 23);
    expect(r.text).toBe("see [text](https://example.com) now");
    expect(r.selected).toBe("text");
  });

  it("wraps the word at the caret", () => {
    const r = run("link", "see the docs", 10);
    expect(r.text).toBe("see the [docs](url)");
    expect(r.selected).toBe("url");
  });

  it("inserts a full placeholder on whitespace with the text selected", () => {
    const r = run("link", "see  now", 4);
    expect(r.text).toBe("see [text](url) now");
    expect(r.selected).toBe("text");
  });

  it("takes a selected link back to its text", () => {
    const r = run("link", "see [docs](https://x) now", 4, 21);
    expect(r.text).toBe("see docs now");
    expect(r.selected).toBe("docs");
  });
});

describe("headings", () => {
  it("prefixes the caret's line and moves the caret with the text", () => {
    const r = run("heading-2", "Title\nbody", 3);
    expect(r.text).toBe("## Title\nbody");
    expect(r.selection).toEqual(cursor(6));
  });

  it("puts a caret at the line start after the prefix", () => {
    const r = run("heading-1", "Title", 0);
    expect(r.text).toBe("# Title");
    expect(r.selection).toEqual(cursor(2));
  });

  it("changes the level of an existing heading", () => {
    expect(run("heading-3", "# Title", 4).text).toBe("### Title");
    expect(run("heading-1", "###   Title", 4).text).toBe("# Title");
  });

  it("clears the heading when the line already has that level", () => {
    const r = run("heading-2", "## Title", 5);
    expect(r.text).toBe("Title");
    expect(r.selection).toEqual(cursor(2));
  });

  it("keeps indentation in front of the marks", () => {
    expect(run("heading-2", "  Title", 4).text).toBe("  ## Title");
    expect(run("heading-2", "  ## Title", 4).text).toBe("  Title");
  });

  it("sets every line of a range, skipping blank lines, and keeps the range on the lines", () => {
    const doc = "one\n\ntwo\nthree";
    const r = run("heading-2", doc, 0, doc.length);
    expect(r.text).toBe("## one\n\n## two\n## three");
    expect(r.selected).toBe("## one\n\n## two\n## three");
  });

  it("clears a range only when every line already has the level", () => {
    const mixed = run("heading-2", "## one\ntwo", 0, 10);
    expect(mixed.text).toBe("## one\n## two");
    const all = run("heading-2", "## one\n## two", 0, 13);
    expect(all.text).toBe("one\ntwo");
  });

  it("leaves out a line the range only reaches the start of", () => {
    const r = run("heading-1", "one\ntwo\nthree", 0, 8);
    expect(r.text).toBe("# one\n# two\nthree");
  });

  it("does not read a #hashtag as a heading", () => {
    expect(run("heading-1", "#tag", 2).text).toBe("# #tag");
  });
});

describe("lists", () => {
  it("bullets the caret's line", () => {
    const r = run("bullet-list", "item", 2);
    expect(r.text).toBe("- item");
    expect(r.selection).toEqual(cursor(4));
  });

  it("makes a lone blank line an empty item to type into", () => {
    const r = run("bullet-list", "", 0);
    expect(r.text).toBe("- ");
    expect(r.selection).toEqual(cursor(2));
  });

  it("numbers a range from one and skips blank lines", () => {
    const doc = "a\nb\n\nc";
    const r = run("numbered-list", doc, 0, doc.length);
    expect(r.text).toBe("1. a\n2. b\n\n3. c");
  });

  it("converts between kinds and strips on a second press", () => {
    expect(run("numbered-list", "- a\n- b", 0, 7).text).toBe("1. a\n2. b");
    expect(run("task-list", "1. a\n2) b", 0, 9).text).toBe("- [ ] a\n- [ ] b");
    expect(run("bullet-list", "- [x] a\n- [ ] b", 0, 15).text).toBe("- a\n- b");
    expect(run("bullet-list", "- a\n* b\n+ c", 0, 11).text).toBe("a\nb\nc");
    expect(run("task-list", "- [ ] a\n- [x] b", 0, 15).text).toBe("a\nb");
  });

  it("sets a mixed range rather than stripping it", () => {
    expect(run("bullet-list", "- a\nb", 0, 5).text).toBe("- a\n- b");
  });

  it("keeps indentation", () => {
    expect(run("bullet-list", "  nested", 4).text).toBe("  - nested");
    expect(run("task-list", "  - nested", 4).text).toBe("  - [ ] nested");
  });

  it("maps a range's ends onto the same lines", () => {
    const r = run("bullet-list", "a\nb", 0, 3);
    expect(r.selected).toBe("- a\n- b");
  });
});

describe("quotes", () => {
  it("quotes the caret's line", () => {
    const r = run("quote", "words", 3);
    expect(r.text).toBe("> words");
    expect(r.selection).toEqual(cursor(5));
  });

  it("quotes blank lines inside a range so the block stays one quote", () => {
    const r = run("quote", "a\n\nb", 0, 4);
    expect(r.text).toBe("> a\n>\n> b");
  });

  it("unquotes only when every line is quoted", () => {
    expect(run("quote", "> a\nb", 0, 5).text).toBe("> a\n> b");
    expect(run("quote", "> a\n>\n> b", 0, 9).text).toBe("a\n\nb");
  });

  it("quotes a lone blank line ready to type", () => {
    expect(run("quote", "", 0)).toMatchObject({ text: "> ", selection: cursor(2) });
  });
});

describe("code blocks", () => {
  it("fences the selected lines and selects what is inside", () => {
    const r = run("code-block", "let x\nlet y", 2, 9);
    expect(r.text).toBe("```\nlet x\nlet y\n```");
    expect(r.selected).toBe("let x\nlet y");
  });

  it("fences the caret's line", () => {
    const r = run("code-block", "before\ncode\nafter", 9);
    expect(r.text).toBe("before\n```\ncode\n```\nafter");
    expect(r.selected).toBe("code");
  });

  it("opens an empty block on a blank line with the caret inside", () => {
    const r = run("code-block", "", 0);
    expect(r.text).toBe("```\n\n```");
    expect(r.selection).toEqual(cursor(4));
  });

  it("removes the fences when the range's first and last lines are fences", () => {
    const doc = "```\nlet x\nlet y\n```";
    const r = run("code-block", doc, 0, doc.length);
    expect(r.text).toBe("let x\nlet y");
    expect(r.selected).toBe("let x\nlet y");
  });

  it("removes an empty fence pair", () => {
    const r = run("code-block", "```\n```", 0, 7);
    expect(r.text).toBe("");
    expect(r.selection).toEqual(cursor(0));
  });

  it("recognises a tilde fence and an indented one", () => {
    expect(run("code-block", "~~~\nx\n~~~", 0, 9).text).toBe("x");
    expect(run("code-block", "  ```\nx\n  ```", 0, 13).text).toBe("x");
  });
});

describe("rules", () => {
  it("goes below the caret's line with a blank line on each side", () => {
    const r = run("rule", "para1\npara2", 2);
    expect(r.text).toBe("para1\n\n---\n\npara2");
    expect(r.selection).toEqual(cursor(11));
    expect(r.text[11]).toBe("\n");
  });

  it("does not double a blank line that is already below", () => {
    const r = run("rule", "para1\n\npara2", 2);
    expect(r.text).toBe("para1\n\n---\n\npara2");
    expect(r.selection).toEqual(cursor(11));
  });

  it("fills a blank line in place, keeping a blank above so the rule is not a setext heading", () => {
    const r = run("rule", "para1\n\npara2", 6);
    expect(r.text).toBe("para1\n\n---\n\npara2");
    expect(r.selection).toEqual(cursor(11));
  });

  it("needs no blank above when the line above is blank or absent", () => {
    expect(run("rule", "", 0)).toMatchObject({ text: "---\n", selection: cursor(4) });
    expect(run("rule", "a\n\n\nb", 3).text).toBe("a\n\n---\n\nb");
  });

  it("ends the document on a fresh line when the caret's line was last", () => {
    const r = run("rule", "para1", 5);
    expect(r.text).toBe("para1\n\n---\n");
    expect(r.selection).toEqual(cursor(r.text.length));
  });
});

describe("tables", () => {
  it("inserts a two-column skeleton with the first header selected", () => {
    const r = run("table", "", 0);
    expect(r.text).toBe("| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n");
    expect(r.selected).toBe("Column 1");
  });

  it("goes below a paragraph with a blank line on each side", () => {
    const r = run("table", "para\nnext", 2);
    expect(r.text).toBe("para\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\nnext");
    expect(r.selected).toBe("Column 1");
  });
});
