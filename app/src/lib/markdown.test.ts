import { describe, it, expect } from "vitest";
import { renderMarkdown } from "$lib/markdown";

describe("renderMarkdown", () => {
  it("keeps a single newline as a line break", () => {
    // The bug: CommonMark folds a soft break into a space, so these two
    // lines rendered as one run of text.
    expect(renderMarkdown("Spec: one\nPlan: two\n")).toBe("<p>Spec: one<br>Plan: two</p>\n");
  });

  it("still separates blank-line-delimited paragraphs", () => {
    expect(renderMarkdown("First\n\nSecond\n")).toBe("<p>First</p>\n<p>Second</p>\n");
  });

  it("leaves code blocks alone", () => {
    expect(renderMarkdown("```\na\nb\n```\n")).toBe("<pre><code>a\nb\n</code></pre>\n");
  });

  it("drops frontmatter instead of rendering it as a heading", () => {
    const html = renderMarkdown("---\nkind: task\nstatus: In Progress\n---\nBody\n");
    expect(html).toBe("<p>Body</p>\n");
  });

  it("renders a file whole when a leading --- is a thematic break, not frontmatter", () => {
    // No closing ---, so this is an ordinary markdown file. Blanking it
    // would hide the whole document.
    const html = renderMarkdown("---\n\nAfter the rule\n");
    expect(html).toContain("After the rule");
  });

  it("renders task list items", () => {
    expect(renderMarkdown("- [x] done\n- [ ] todo\n")).toContain('type="checkbox"');
  });
});
