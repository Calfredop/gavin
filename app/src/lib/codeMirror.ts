import { fileExtension } from "$lib/fileTypes";
// Type-only import: erased at compile time, so it does not violate the
// no-runtime-CodeMirror-imports rule below.
import type { Extension } from "@codemirror/state";
import { applyFormat, chordToKeyName, FORMAT_GROUPS, type FormatAction } from "$lib/markdownFormatting";

// NO top-level runtime @codemirror imports in this module. Every one of
// them is dynamic, inside a function, so codeMirror.test.ts can import
// this file under vitest's node environment without dragging
// DOM-dependent CodeMirror modules in. (This project has no jsdom and no
// component tests -- see the plan's Global Constraints.)

// Extension -> language pack id. An extension absent from here is not an
// error: the file opens as editable plain text, which is the right
// outcome for .log, .toml, or an extensionless Makefile.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  ts: "javascript",
  tsx: "javascript",
  js: "javascript",
  jsx: "javascript",
  rs: "rust",
  py: "python",
  json: "json",
  html: "html",
  svelte: "html",
  xml: "html",
  css: "css",
  scss: "css",
  yaml: "yaml",
  yml: "yaml",
};

export function languageIdForPath(path: string): string | null {
  return LANGUAGE_BY_EXTENSION[fileExtension(path)] ?? null;
}

// Lazy: opening a markdown file must never load the Rust grammar.
async function languageExtension(path: string): Promise<Extension[]> {
  switch (languageIdForPath(path)) {
    case "markdown":
      return [(await import("@codemirror/lang-markdown")).markdown()];
    case "javascript": {
      const ext = fileExtension(path);
      const { javascript } = await import("@codemirror/lang-javascript");
      return [javascript({ typescript: ext === "ts" || ext === "tsx", jsx: ext.endsWith("x") })];
    }
    case "rust":
      return [(await import("@codemirror/lang-rust")).rust()];
    case "python":
      return [(await import("@codemirror/lang-python")).python()];
    case "json":
      return [(await import("@codemirror/lang-json")).json()];
    case "html":
      return [(await import("@codemirror/lang-html")).html()];
    case "css":
      return [(await import("@codemirror/lang-css")).css()];
    case "yaml":
      return [(await import("@codemirror/lang-yaml")).yaml()];
    default:
      return [];
  }
}

export interface EditorHandle {
  setDoc(text: string): void;
  setReadOnly(readOnly: boolean): void;
  setTheme(theme: "light" | "dark"): void;
  /// Current buffer (LF-normalised by CodeMirror).
  getDoc(): string;
  /// Scrolls the 0-based line into view, centred.
  scrollToLine(line: number): void;
  /// Dispatches state effects (used by decoration extensions).
  dispatchEffects(effects: unknown[]): void;
  /// Applies one of the markdown bar's actions at the current selection
  /// and returns focus to the editor. A no-op while read-only.
  format(action: FormatAction): void;
  measure(): void;
  destroy(): void;
}

export interface CreateEditorOptions {
  parent: HTMLElement;
  doc: string;
  path: string;
  readOnly: boolean;
  theme: "light" | "dark";
  onChange: (value: string) => void;
  onSave: () => void;
  /// Extra CodeMirror extensions appended to the defaults (e.g. the merge
  /// editor's region decorations).
  extensions?: unknown[];
}

export async function createEditor(options: CreateEditorOptions): Promise<EditorHandle> {
  const [stateMod, view, commands, themeOneDark, languageMod, language] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/commands"),
    import("@codemirror/theme-one-dark"),
    import("@codemirror/language"),
    languageExtension(options.path),
  ]);
  const { EditorState, Compartment } = stateMod;
  const { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } = view;

  const readOnlyCompartment = new Compartment();
  const themeCompartment = new Compartment();

  // The bar's transforms are pure over (doc, selection); this is the one
  // place they meet a live view. Returns whether it acted, which is what
  // a keymap binding needs: in Plain mode the chord falls through to
  // whatever CodeMirror bound it to.
  const format = (view: InstanceType<typeof EditorView>, action: FormatAction): boolean => {
    if (view.state.readOnly) return false;
    const { anchor, head } = view.state.selection.main;
    const result = applyFormat(action, view.state.doc.toString(), { anchor, head });
    view.dispatch({
      changes: result.changes,
      selection: result.selection,
      scrollIntoView: true,
      userEvent: "input.format",
    });
    return true;
  };
  // Only a markdown file gets the chords: ⌘B in a .rs file means nothing
  // and must not put stars in the source. The table that draws the bar
  // is the table that binds the keys.
  const formatKeymap =
    languageIdForPath(options.path) === "markdown"
      ? FORMAT_GROUPS.flat()
          .filter((button) => button.chord)
          .map((button) => ({
            key: chordToKeyName(button.chord!),
            preventDefault: true,
            run: (view: InstanceType<typeof EditorView>) => format(view, button.action),
          }))
      : [];

  /// oneDark bundles its own HighlightStyle, and it is the ONLY source of
  /// syntax colour here -- there is no defaultHighlightStyle in the
  /// extension list. So the light arm has to supply one, or light mode
  /// would render every token in the same flat colour.
  const themeFor = (theme: "light" | "dark") =>
    theme === "dark"
      ? themeOneDark.oneDark
      : [
          languageMod.syntaxHighlighting(languageMod.defaultHighlightStyle),
          EditorView.theme(
            {
              "&": { backgroundColor: "var(--surface-base)", color: "var(--text)" },
              ".cm-content": { caretColor: "var(--text)" },
              ".cm-gutters": {
                backgroundColor: "var(--surface-raised)",
                color: "var(--text-subtle)",
                border: "none",
              },
              ".cm-activeLine": { backgroundColor: "var(--surface-hover)" },
              ".cm-activeLineGutter": { backgroundColor: "var(--surface-hover)" },
              "&.cm-focused .cm-selectionBackground, ::selection": {
                backgroundColor: "var(--surface-selected)",
              },
            },
            { dark: false }
          ),
        ];

  const state = EditorState.create({
    doc: options.doc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      commands.history(),
      // Mod-s and the format chords first so they win over any default
      // binding (defaultKeymap has Mod-i as "select parent syntax").
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            options.onSave();
            return true;
          },
        },
        ...formatKeymap,
        ...commands.defaultKeymap,
        ...commands.historyKeymap,
      ]),
      themeCompartment.of(themeFor(options.theme)),
      EditorView.lineWrapping,
      readOnlyCompartment.of([
        EditorState.readOnly.of(options.readOnly),
        EditorView.editable.of(!options.readOnly),
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onChange(update.state.doc.toString());
      }),
      ...language,
      ...((options.extensions ?? []) as never[]),
    ],
  });

  const editorView = new EditorView({ state, parent: options.parent });

  return {
    setDoc(text: string) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: text },
      });
    },
    setReadOnly(readOnly: boolean) {
      // Compartment reconfigure rather than remount: a mode switch must
      // not throw away scroll position and undo history.
      editorView.dispatch({
        effects: readOnlyCompartment.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      });
    },
    setTheme(theme: "light" | "dark") {
      // Compartment reconfigure, same reason as setReadOnly: a theme flip
      // must not throw away scroll position or undo history.
      editorView.dispatch({ effects: themeCompartment.reconfigure(themeFor(theme)) });
    },
    getDoc() {
      return editorView.state.doc.toString();
    },
    scrollToLine(line: number) {
      const n = Math.min(Math.max(1, line + 1), editorView.state.doc.lines);
      editorView.dispatch({ effects: EditorView.scrollIntoView(editorView.state.doc.line(n).from, { y: "center" }) });
    },
    dispatchEffects(effects: unknown[]) {
      editorView.dispatch({ effects: effects as never[] });
    },
    format(action: FormatAction) {
      format(editorView, action);
      // A bar click took focus even with mousedown prevented on some
      // WebKit paths; typing must continue in the editor either way.
      editorView.focus();
    },
    measure() {
      editorView.requestMeasure();
    },
    destroy() {
      editorView.destroy();
    },
  };
}
