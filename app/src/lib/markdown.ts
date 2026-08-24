// The one markdown-to-HTML pass in the app, shared by the file viewer's
// Formatted mode and the card detail modal's body preview.
//
// Sanitizing is deliberately left to the callers: DOMPurify needs a real
// window, and keeping it out lets this module -- the part with the
// rendering decisions in it -- be unit-tested in the node test env.

import { marked } from "marked";
import { bodyStart } from "./planChecklist";

export function renderMarkdown(content: string): string {
  // `breaks: true` renders a single newline as <br>, the way GitHub
  // renders issue and comment bodies. CommonMark's default folds a soft
  // break into a space, which silently ran consecutive lines together --
  // a card's "Spec: ...\nPlan: ..." came out as one line of prose.
  return marked.parse(previewBody(content), { async: false, breaks: true }) as string;
}

// Frontmatter is metadata, not prose: rendered as markdown its closing
// --- turns the whole block into a setext heading, so a card opened in
// the viewer led with its own metadata squashed onto one heading line.
//
// An UNTERMINATED --- block is not frontmatter at all -- in an ordinary
// markdown file that opening --- is a thematic break -- so the file is
// rendered whole rather than blanked.
function previewBody(content: string): string {
  const lines = content.split("\n");
  const start = bodyStart(lines);
  if (start === null || start === 0) return content;
  return lines.slice(start).join("\n");
}
