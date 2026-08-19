// Small path helpers shared by the file editor and its callers.
// (Syntax-highlighting language selection lives in codeMirror.ts.)

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

