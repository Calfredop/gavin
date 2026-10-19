// The one place repository markdown becomes trusted HTML for `{@html}`.
// Callers used to sanitize with DOMPurify's default config, which keeps
// <style> and style= and lets a card body restyle consent prompts in the
// same document. FORBID_TAGS / FORBID_ATTR close that; marked's table
// alignment uses align=, not style=, so forbidding style leaves tables
// intact. renderMarkdown stays DOM-free (see markdown.ts).

import DOMPurify from "dompurify";
import { renderMarkdown } from "$lib/files/markdown";

export function sanitizeMarkdown(content: string): string {
  return DOMPurify.sanitize(renderMarkdown(content), {
    FORBID_TAGS: ["style"],
    FORBID_ATTR: ["style"],
  });
}
