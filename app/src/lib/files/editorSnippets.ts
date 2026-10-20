// Curated snippets layered on top of each language pack's built-in
// completions. Pure data: CodeMirror's snippetCompletion only meets them
// inside createEditor, so this file stays loadable under vitest's node
// environment. Markdown is deliberately omitted — its language pack's
// completions already cover the marks a human reaches for.

export interface EditorSnippet {
  /// What the completion list shows and what the human types to filter.
  label: string;
  /// Short hint beside the label.
  detail: string;
  /// CodeMirror snippet template (`${name}` placeholders, `${}` for the
  /// final tab-stop). Tabs indent so indentWithTab / language indent keep
  /// nested fields aligned after insert.
  template: string;
}

const JAVASCRIPT: readonly EditorSnippet[] = [
  {
    label: "log",
    detail: "console.log",
    template: "console.log(${})",
  },
  {
    label: "fn",
    detail: "function",
    template: "function ${name}(${params}) {\n\t${}\n}",
  },
  {
    label: "afn",
    detail: "async function",
    template: "async function ${name}(${params}) {\n\t${}\n}",
  },
  {
    label: "forof",
    detail: "for-of loop",
    template: "for (const ${item} of ${items}) {\n\t${}\n}",
  },
  {
    label: "im",
    detail: "named import",
    template: 'import { ${names} } from "${module}"',
  },
];

const RUST: readonly EditorSnippet[] = [
  {
    label: "fn",
    detail: "function",
    template: "fn ${name}(${params}) {\n\t${}\n}",
  },
  {
    label: "println",
    detail: "println!",
    template: 'println!("${}");',
  },
  {
    label: "match",
    detail: "match",
    template: "match ${expr} {\n\t${pat} => ${},\n}",
  },
  {
    label: "struct",
    detail: "struct",
    template: "struct ${Name} {\n\t${}\n}",
  },
  {
    label: "impl",
    detail: "impl block",
    template: "impl ${Name} {\n\t${}\n}",
  },
];

const PYTHON: readonly EditorSnippet[] = [
  {
    label: "def",
    detail: "function",
    template: "def ${name}(${params}):\n\t${}",
  },
  {
    label: "print",
    detail: "print",
    template: "print(${})",
  },
  {
    label: "for",
    detail: "for loop",
    template: "for ${item} in ${items}:\n\t${}",
  },
  {
    label: "class",
    detail: "class",
    template: "class ${Name}:\n\tdef __init__(self${params}):\n\t\t${}",
  },
  {
    label: "ifmain",
    detail: "if __name__",
    template: 'if __name__ == "__main__":\n\t${}',
  },
];

const BY_LANGUAGE: Record<string, readonly EditorSnippet[]> = {
  javascript: JAVASCRIPT,
  rust: RUST,
  python: PYTHON,
};

/// Snippets for the language pack id `languageIdForPath` returns, or an
/// empty list when the language has none (json, markdown, plain text, …).
export function snippetsForLanguage(languageId: string | null): readonly EditorSnippet[] {
  if (languageId === null) return [];
  return BY_LANGUAGE[languageId] ?? [];
}
