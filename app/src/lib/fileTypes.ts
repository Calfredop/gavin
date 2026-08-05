// Maps file extensions to highlight.js language ids. Only extensions
// whose language highlight.js actually ships in its common bundle are
// listed -- an extension absent from here still renders, just as plain
// unhighlighted text (fileLanguage returns null), which is the correct
// fallback for a .log or an extensionless Makefile.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  svelte: "xml",
  rs: "rust",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  xml: "xml",
  html: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  graphql: "graphql",
  lua: "lua",
  php: "php",
  pl: "perl",
  r: "r",
  csv: "plaintext",
};

// Lowercased extension of a path, or "" when there is none. Only looks
// at the final path segment, so a dot in a parent directory
// (/tmp/my.dir/plainfile) is never mistaken for an extension.
export function fileExtension(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isMarkdown(path: string): boolean {
  const ext = fileExtension(path);
  return ext === "md" || ext === "markdown";
}

// The highlight.js language id for a path, or null to render it as plain
// unhighlighted text.
export function fileLanguage(path: string): string | null {
  return LANGUAGE_BY_EXTENSION[fileExtension(path)] ?? null;
}
