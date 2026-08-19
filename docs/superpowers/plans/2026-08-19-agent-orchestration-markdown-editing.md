# Markdown Editing (CodeMirror 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the read-only file viewer becomes an editor — every viewable text file editable, markdown with a Formatted/Plain/Edit switch, plus PRD and agent-file hub tabs.

**Architecture:** `FileEditor.svelte` becomes the single editing unit (load, watch, modes, autosave, conflicts); `FileViewerPane` shrinks to a pane wrapper and two tiny hub-view wrappers reuse the same component. CodeMirror lives behind `codeMirror.ts`, which has **no top-level CodeMirror imports** (all dynamic) so its language mapping stays unit-testable in vitest's node environment. All decision logic — external-change verdicts, editability, mode sets — is pure and tested in `fileEditing.ts`.

**Tech Stack:** CodeMirror 6 (individual packages, lazy language packs). highlight.js is **removed** — Plain mode is CodeMirror read-only.

**Spec:** `docs/superpowers/specs/2026-08-19-agent-orchestration-markdown-editing-design.md` — the requirements authority. Decisions D8, D23–D26 in `docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`.

## Global Constraints

- User works directly on `main`, no worktrees. Inline execution is the standing fallback (subagent-cap history).
- **No Svelte component tests** — vitest here cannot preprocess `.svelte`; a test that merely imports one fails at collection. Logic that needs testing goes in `.ts` modules.
- **`codeMirror.ts` must not import CodeMirror at module scope.** All `@codemirror/*` imports are dynamic, inside functions — otherwise its unit test drags DOM-dependent modules into node.
- **Truncated files are never editable** (only a prefix was read; a save would destroy the tail).
- **Editor owns the buffer after mount.** The `doc` prop is initial content only; the parent pushes content afterwards solely via the explicit `setDoc` handle. Reactively re-pushing on every keystroke would fight the cursor.
- Autosave is **suspended while a conflict is unresolved** — otherwise the next keystroke silently overwrites the external change the banner just warned about. ⌘S during a conflict means "keep mine" and resolves it.
- Vitest lesson (hit three times): a mocked backend function that gets `.catch()`ed needs `.mockResolvedValue(undefined)` in the factory.
- Verification gates per task: `cargo test`, `npx vitest run`, `npx svelte-check` (must stay at 0 errors), `cargo build`.

---

### Task 1: CodeMirror dependencies + `codeMirror.ts`

**Files:**
- Modify: `app/package.json`
- Create: `app/src/lib/codeMirror.ts`
- Test: `app/src/lib/codeMirror.test.ts`

**Interfaces:**
- Produces (for Task 4): `languageIdForPath(path): string | null`; `createEditor(options): Promise<EditorHandle>` where `EditorHandle = { setDoc(text: string): void; setReadOnly(ro: boolean): void; measure(): void; destroy(): void }`.

- [ ] **Step 1: Install** (from `app/`):

```bash
npm install @codemirror/state@^6 @codemirror/view@^6 @codemirror/commands@^6 \
  @codemirror/language@^6 @codemirror/theme-one-dark@^6 \
  @codemirror/lang-markdown@^6 @codemirror/lang-javascript@^6 @codemirror/lang-rust@^6 \
  @codemirror/lang-python@^6 @codemirror/lang-json@^6 @codemirror/lang-html@^6 \
  @codemirror/lang-css@^6 @codemirror/lang-yaml@^6
```

Individual packages, not the `codemirror` meta-package (which pulls autocomplete + lint we do not use).

- [ ] **Step 2: Write the failing test** (`codeMirror.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import { languageIdForPath } from "./codeMirror";

describe("languageIdForPath", () => {
  it("maps known extensions to a language id", () => {
    expect(languageIdForPath("/tmp/a.md")).toBe("markdown");
    expect(languageIdForPath("/tmp/a.markdown")).toBe("markdown");
    expect(languageIdForPath("/tmp/a.ts")).toBe("javascript");
    expect(languageIdForPath("/tmp/a.tsx")).toBe("javascript");
    expect(languageIdForPath("/tmp/a.rs")).toBe("rust");
    expect(languageIdForPath("/tmp/a.py")).toBe("python");
    expect(languageIdForPath("/tmp/a.json")).toBe("json");
    expect(languageIdForPath("/tmp/a.html")).toBe("html");
    expect(languageIdForPath("/tmp/a.svelte")).toBe("html");
    expect(languageIdForPath("/tmp/a.css")).toBe("css");
    expect(languageIdForPath("/tmp/a.scss")).toBe("css");
    expect(languageIdForPath("/tmp/a.yaml")).toBe("yaml");
    expect(languageIdForPath("/tmp/a.yml")).toBe("yaml");
  });

  it("returns null for extensions with no pack, so they open as plain text", () => {
    expect(languageIdForPath("/tmp/a.log")).toBeNull();
    expect(languageIdForPath("/tmp/a.toml")).toBeNull();
    expect(languageIdForPath("/tmp/Makefile")).toBeNull();
  });

  it("is case-insensitive on the extension", () => {
    expect(languageIdForPath("/tmp/README.MD")).toBe("markdown");
  });
});
```

- [ ] **Step 3: Run it, expect failure** — `cd app && npx vitest run src/lib/codeMirror.test.ts` → module not found.

- [ ] **Step 4: Implement `codeMirror.ts`:**

```typescript
import { fileExtension } from "./fileTypes";

// NO top-level @codemirror imports in this module. Every one of them is
// dynamic, inside a function, so that codeMirror.test.ts can import this
// file under vitest's node environment without dragging DOM-dependent
// CodeMirror modules in. (This project has no jsdom and no component
// tests -- see the plan's Global Constraints.)

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
async function languageExtension(path: string): Promise<unknown[]> {
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
  measure(): void;
  destroy(): void;
}

export interface CreateEditorOptions {
  parent: HTMLElement;
  doc: string;
  path: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

export async function createEditor(options: CreateEditorOptions): Promise<EditorHandle> {
  const [{ EditorState, Compartment }, view, commands, themeOneDark, language] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/commands"),
    import("@codemirror/theme-one-dark"),
    languageExtension(options.path),
  ]);
  const { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } = view;

  const readOnlyCompartment = new Compartment();

  const state = EditorState.create({
    doc: options.doc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      commands.history(),
      // Mod-s first so it wins over any default binding.
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            options.onSave();
            return true;
          },
        },
        ...commands.defaultKeymap,
        ...commands.historyKeymap,
      ]),
      themeOneDark.oneDark,
      EditorView.lineWrapping,
      readOnlyCompartment.of([
        EditorState.readOnly.of(options.readOnly),
        EditorView.editable.of(!options.readOnly),
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onChange(update.state.doc.toString());
      }),
      ...(language as never[]),
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
    measure() {
      editorView.requestMeasure();
    },
    destroy() {
      editorView.destroy();
    },
  };
}
```

- [ ] **Step 5: Run the test** — passes. Then `npx svelte-check` (0 errors) — if the `language as never[]` cast trips it, type `languageExtension` as `Promise<Extension[]>` using a `type { Extension }` **type-only** import (type imports are erased, so they do not violate the no-top-level-import rule).

- [ ] **Step 6: Commit** — `git add app/package.json app/package-lock.json app/src/lib/codeMirror.ts app/src/lib/codeMirror.test.ts && git commit -m "feat(editor): codemirror 6 dependencies and lazy language resolution"`

---

### Task 2: Write path — Rust command + `exists` flag

**Files:**
- Modify: `app/src-tauri/src/fileviewer.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/lib/backend.ts`

**Interfaces:**
- Produces (for Tasks 3–6): `FileContent { content, truncated, exists }`; command `write_file_for_editor(path, content)`; `backend.writeFileForEditor(path, content): Promise<void>` and the updated `readFileForViewer` return type.

- [ ] **Step 1: Add `exists` to `FileContent`** (keep the existing derives exactly as they are, add one field):

```rust
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    /// False when the path does not exist yet. The PRD/agent-file hub
    /// tabs open before their file has been created and create it on
    /// first save, so "missing" is a normal state to render, not an
    /// error to show.
    pub exists: bool,
}
```

- [ ] **Step 2: Make `read_file_for_viewer` tolerate a missing file** — replace its first line:

```rust
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileContent { content: String::new(), truncated: false, exists: false })
        }
        Err(e) => return Err(e.to_string()),
    };
```

and set `exists: true` in the success return. Every other error (permissions, non-UTF8) still fails as before. Update the two existing `FileContent { .. }` literals in that file's tests to include `exists: true`.

- [ ] **Step 3: Add the write command** (below `read_file_for_viewer`):

```rust
/// Writes an editor buffer back to disk, creating the file when absent.
/// Plain `fs::write`, matching `gavin::write_plan_field`'s convention
/// rather than introducing temp-file-plus-rename in one place only.
///
/// Callers must never invoke this for a truncated read: only a prefix of
/// an over-cap file was loaded, so writing it back would destroy the
/// rest. `FileEditor` enforces that by refusing to offer Edit mode at
/// all when `truncated` is true.
#[tauri::command]
pub fn write_file_for_editor(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Tests** (in `fileviewer.rs`'s `mod tests`):

```rust
    #[test]
    fn write_creates_a_missing_file_and_overwrites_an_existing_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        let p = path.to_string_lossy().to_string();

        write_file_for_editor(p.clone(), "first".to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

        write_file_for_editor(p, "second".to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    }

    #[test]
    fn write_round_trips_multibyte_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prd.md");
        let text = "# PRD — vision\n\nemoji: 🚀 accents: éàü\n";
        write_file_for_editor(path.to_string_lossy().to_string(), text.to_string()).unwrap();

        let read = read_file_for_viewer(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(read.content, text);
        assert!(read.exists);
        assert!(!read.truncated);
    }

    #[test]
    fn write_to_an_unwritable_path_errors() {
        let dir = tempfile::tempdir().unwrap();
        // The directory itself is not a writable file target.
        let result = write_file_for_editor(dir.path().to_string_lossy().to_string(), "x".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn reading_a_missing_file_reports_it_absent_instead_of_erroring() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("CLAUDE.md");

        let result = read_file_for_viewer(missing.to_string_lossy().to_string()).unwrap();

        assert!(!result.exists);
        assert_eq!(result.content, "");
        assert!(!result.truncated);
    }
```

- [ ] **Step 5: Register** `fileviewer::write_file_for_editor` in `lib.rs`'s `generate_handler![...]`, beside the other `fileviewer::` entries.

- [ ] **Step 6: backend.ts** — update the read wrapper's type and add the writer:

```typescript
export function readFileForViewer(
  path: string
): Promise<{ content: string; truncated: boolean; exists: boolean }> {
  return invoke("read_file_for_viewer", { path });
}

export function writeFileForEditor(path: string, content: string): Promise<void> {
  return invoke("write_file_for_editor", { path, content });
}
```

- [ ] **Step 7: Verify** — `cargo test -p app` green, `cargo build` clean, `npx svelte-check` 0 errors.

- [ ] **Step 8: Commit** — `git add app && git commit -m "feat(editor): file write command and exists flag on reads"`

---

### Task 3: `fileEditing.ts` — the decision logic

**Files:**
- Create: `app/src/lib/fileEditing.ts`
- Test: `app/src/lib/fileEditing.test.ts`

**Interfaces:**
- Produces (for Tasks 4–6): `type EditorMode = "formatted" | "plain" | "edit"`; `modesFor(path)`; `defaultMode(path, surface)`; `canEdit({ truncated, error })`; `resolveExternalChange({ incoming, buffer, dirty })`; the `dirtyPaths` store with `setPathDirty`.

- [ ] **Step 1: Write the failing tests** (`fileEditing.test.ts`):

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  modesFor,
  defaultMode,
  canEdit,
  resolveExternalChange,
  dirtyPaths,
  setPathDirty,
} from "./fileEditing";

describe("modesFor", () => {
  it("offers all three modes for markdown", () => {
    expect(modesFor("/tmp/a.md")).toEqual(["formatted", "plain", "edit"]);
  });

  it("offers plain and edit for every other text file", () => {
    expect(modesFor("/tmp/a.rs")).toEqual(["plain", "edit"]);
    expect(modesFor("/tmp/a.log")).toEqual(["plain", "edit"]);
  });
});

describe("defaultMode", () => {
  it("opens file tabs read-first", () => {
    expect(defaultMode("/tmp/a.md", "tab")).toBe("formatted");
    expect(defaultMode("/tmp/a.rs", "tab")).toBe("plain");
  });

  it("opens hub tabs (PRD, agent file) in edit", () => {
    expect(defaultMode("/root/.gavin-root/PRD.md", "hub")).toBe("edit");
    expect(defaultMode("/root/CLAUDE.md", "hub")).toBe("edit");
  });
});

describe("canEdit", () => {
  it("allows editing a normally-loaded file, including one that doesn't exist yet", () => {
    expect(canEdit({ truncated: false, error: null })).toBe(true);
  });

  it("refuses a truncated file -- saving a prefix would destroy the tail", () => {
    expect(canEdit({ truncated: true, error: null })).toBe(false);
  });

  it("refuses a file that failed to load", () => {
    expect(canEdit({ truncated: false, error: "file is not valid UTF-8 text" })).toBe(false);
  });
});

describe("resolveExternalChange", () => {
  it("ignores an echo of our own save", () => {
    expect(resolveExternalChange({ incoming: "same", buffer: "same", dirty: false })).toBe("ignore");
  });

  it("ignores identical content even while dirty", () => {
    // Someone else wrote exactly what we already have: nothing to warn about.
    expect(resolveExternalChange({ incoming: "same", buffer: "same", dirty: true })).toBe("ignore");
  });

  it("reloads silently when the buffer is clean", () => {
    expect(resolveExternalChange({ incoming: "theirs", buffer: "ours", dirty: false })).toBe("reload");
  });

  it("raises a conflict when the buffer is dirty", () => {
    expect(resolveExternalChange({ incoming: "theirs", buffer: "ours", dirty: true })).toBe("conflict");
  });
});

describe("dirtyPaths", () => {
  beforeEach(() => dirtyPaths.set(new Set()));

  it("tracks and clears per path", () => {
    setPathDirty("/tmp/a.md", true);
    setPathDirty("/tmp/b.md", true);
    expect(get(dirtyPaths).has("/tmp/a.md")).toBe(true);

    setPathDirty("/tmp/a.md", false);
    expect(get(dirtyPaths).has("/tmp/a.md")).toBe(false);
    expect(get(dirtyPaths).has("/tmp/b.md")).toBe(true);
  });

  it("does not allocate a new set when nothing changes", () => {
    setPathDirty("/tmp/a.md", true);
    const first = get(dirtyPaths);
    setPathDirty("/tmp/a.md", true);
    expect(get(dirtyPaths)).toBe(first);
  });
});
```

- [ ] **Step 2: Run them, expect failure** (module not found).

- [ ] **Step 3: Implement `fileEditing.ts`:**

```typescript
import { writable } from "svelte/store";
import { isMarkdown } from "./fileTypes";

export type EditorMode = "formatted" | "plain" | "edit";

// Markdown has a rendered form; nothing else does.
export function modesFor(path: string): EditorMode[] {
  return isMarkdown(path) ? ["formatted", "plain", "edit"] : ["plain", "edit"];
}

// File tabs are opened by cmd+clicking a path in terminal output -- a
// read-first gesture. The PRD and agent-file hub tabs exist to be
// written, so they open ready to type (D25).
export function defaultMode(path: string, surface: "tab" | "hub"): EditorMode {
  if (surface === "hub") return "edit";
  return isMarkdown(path) ? "formatted" : "plain";
}

// A file that failed to load has no buffer to edit; a truncated one holds
// only a prefix, so writing it back would destroy everything past the
// cap. A file that merely doesn't exist yet IS editable -- saving creates
// it, which is how the agent-file tab bootstraps CLAUDE.md.
export function canEdit(state: { truncated: boolean; error: string | null }): boolean {
  return !state.truncated && state.error === null;
}

export type ExternalChangeVerdict = "ignore" | "reload" | "conflict";

// Content-based, never time-based (D26): our own save trips the watcher,
// and a timing window would be defeated by a slow disk. If what landed on
// disk equals what we already have, there is nothing to do -- that covers
// both our echo and someone writing identical content.
export function resolveExternalChange(input: {
  incoming: string;
  buffer: string;
  dirty: boolean;
}): ExternalChangeVerdict {
  if (input.incoming === input.buffer) return "ignore";
  return input.dirty ? "conflict" : "reload";
}

// Paths with unsaved buffers, so Pane.svelte can show a dot on the tab
// without reaching into the editor component.
export const dirtyPaths = writable<Set<string>>(new Set());

export function setPathDirty(path: string, dirty: boolean): void {
  dirtyPaths.update((current) => {
    if (current.has(path) === dirty) return current;
    const next = new Set(current);
    if (dirty) {
      next.add(path);
    } else {
      next.delete(path);
    }
    return next;
  });
}
```

- [ ] **Step 4: Run** — all green.

- [ ] **Step 5: Commit** — `git add app/src/lib/fileEditing.ts app/src/lib/fileEditing.test.ts && git commit -m "feat(editor): pure editing logic — modes, editability, change verdicts"`

---

### Task 4: `CodeMirrorView.svelte` + `FileEditor.svelte`

**Files:**
- Create: `app/src/lib/CodeMirrorView.svelte`
- Create: `app/src/lib/FileEditor.svelte`

**Interfaces:**
- Consumes: Tasks 1–3 plus existing `backend.readFileForViewer` / `watchFileForViewer` / `unwatchFileForViewer`, the `file-changed` Tauri event, `marked` + `DOMPurify`.
- Produces (for Tasks 5–6): `<FileEditor path initialMode />` exposing `measure()`.

- [ ] **Step 1: `CodeMirrorView.svelte`** — a dumb mount/teardown shell:

```svelte
<script lang="ts">
  import { onDestroy } from "svelte";
  import { createEditor, type EditorHandle } from "./codeMirror";

  interface Props {
    // Initial content only: once mounted, the EDITOR owns the buffer.
    // Pushing `doc` back in on every change would fight the cursor --
    // the parent uses setDoc() for deliberate reloads instead.
    doc: string;
    path: string;
    readOnly: boolean;
    onChange: (value: string) => void;
    onSave: () => void;
  }
  let { doc, path, readOnly, onChange, onSave }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  // $state, not a plain let: the readOnly effect below must re-run once
  // the async mount resolves, otherwise a mode switch made while the
  // language pack was still loading is silently lost.
  let handle = $state<EditorHandle | null>(null);
  let destroyed = false;
  // Content handed to setDoc before the editor existed. Applied the
  // moment it does, so a reload or conflict resolution can never be
  // swallowed by a slow dynamic import.
  let pendingDoc: string | null = null;

  export function setDoc(text: string): void {
    if (handle) {
      handle.setDoc(text);
    } else {
      pendingDoc = text;
    }
  }

  export function measure(): void {
    handle?.measure();
  }

  $effect(() => {
    if (!host || handle) return;
    const parent = host;
    void createEditor({ parent, doc, path, readOnly, onChange, onSave }).then((created) => {
      // The component may have been destroyed while the language pack
      // was still loading.
      if (destroyed) {
        created.destroy();
        return;
      }
      handle = created;
      if (pendingDoc !== null) {
        created.setDoc(pendingDoc);
        pendingDoc = null;
      }
    });
  });

  // Mode switches reconfigure the live editor rather than remounting it,
  // so scroll position and undo history survive.
  $effect(() => {
    const ro = readOnly;
    handle?.setReadOnly(ro);
  });

  onDestroy(() => {
    destroyed = true;
    handle?.destroy();
    handle = null;
  });
</script>

<div class="cm-host" bind:this={host}></div>

<style>
  .cm-host {
    height: 100%;
    overflow: hidden;
  }
  .cm-host :global(.cm-editor) {
    height: 100%;
    font-size: 0.85em;
  }
  .cm-host :global(.cm-scroller) {
    font-family: monospace;
  }
</style>
```

- [ ] **Step 2: `FileEditor.svelte`** — the orchestrator. Copy the `.pane`, `.overlay`, `.detail`, `.notice`, `.markdown` style blocks verbatim from the current `FileViewerPane.svelte` (they are unchanged; only `.code` is dropped, since Plain is now CodeMirror) and add the `.modes`/`.conflict` rules below:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { openPath } from "@tauri-apps/plugin-opener";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { isMarkdown } from "./fileTypes";
  import {
    canEdit,
    defaultMode,
    modesFor,
    resolveExternalChange,
    setPathDirty,
    type EditorMode,
  } from "./fileEditing";
  import CodeMirrorView from "./CodeMirrorView.svelte";
  import * as backend from "./backend";

  interface Props {
    path: string;
    initialMode?: EditorMode;
  }
  let { path, initialMode }: Props = $props();

  const AUTOSAVE_MS = 1000;

  let mode = $state<EditorMode>(initialMode ?? defaultMode(path, "tab"));
  let buffer = $state("");
  let dirty = $state(false);
  let truncated = $state(false);
  let exists = $state(true);
  let error = $state<string | null>(null);
  let openError = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  // Non-null while an external change is waiting on the user's choice.
  let conflict = $state<string | null>(null);

  // Gates the editor's first render: CodeMirrorView takes `doc` as
  // INITIAL content only, so mounting it before the first read resolves
  // would leave an editor holding "" with no path back to the real file.
  let loaded = $state(false);
  let editor = $state<{ setDoc: (t: string) => void; measure: () => void } | null>(null);
  let unlisten: UnlistenFn | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const editable = $derived(canEdit({ truncated, error }));
  const availableModes = $derived(modesFor(path));
  // Never leave the user stranded in Edit on a file that can't be edited.
  const effectiveMode = $derived<EditorMode>(mode === "edit" && !editable ? "plain" : mode);

  const rendered = $derived.by(() => {
    if (error !== null || effectiveMode !== "formatted") return "";
    // Renders the BUFFER, so preview reflects unsaved edits.
    return DOMPurify.sanitize(marked.parse(buffer, { async: false }) as string);
  });

  export function measure(): void {
    editor?.measure();
  }

  async function load(): Promise<void> {
    try {
      const result = await backend.readFileForViewer(path);
      buffer = result.content;
      truncated = result.truncated;
      exists = result.exists;
      error = null;
      setDirty(false);
      editor?.setDoc(result.content);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loaded = true;
    }
  }

  function setDirty(next: boolean): void {
    dirty = next;
    setPathDirty(path, next);
  }

  function handleChange(value: string): void {
    buffer = value;
    setDirty(true);
    // Autosave stays suspended while a conflict is unresolved -- else the
    // next keystroke would silently overwrite the change the banner is
    // warning about.
    if (conflict !== null) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), AUTOSAVE_MS);
  }

  async function save(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!editable || !dirty) return;
    try {
      await backend.writeFileForEditor(path, buffer);
      saveError = null;
      exists = true;
      setDirty(false);
    } catch (e) {
      saveError = String(e instanceof Error ? e.message : e);
    }
  }

  // ⌘S during a conflict means "keep mine": resolve, then write.
  function saveNow(): void {
    conflict = null;
    void save();
  }

  function switchMode(next: EditorMode): void {
    if (mode === "edit" && next !== "edit") void save();
    mode = next;
  }

  function keepMine(): void {
    conflict = null;
    void save();
  }

  function takeTheirs(): void {
    const theirs = conflict ?? "";
    conflict = null;
    buffer = theirs;
    setDirty(false);
    editor?.setDoc(theirs);
  }

  async function openExternally(): Promise<void> {
    try {
      openError = null;
      await openPath(path);
    } catch (e) {
      openError = String(e instanceof Error ? e.message : e);
    }
  }

  async function handleExternalChange(): Promise<void> {
    let incoming: string;
    try {
      const result = await backend.readFileForViewer(path);
      incoming = result.content;
      truncated = result.truncated;
      exists = result.exists;
    } catch {
      // A transient read failure mid-write is not worth a banner; the
      // next event re-reads.
      return;
    }
    switch (resolveExternalChange({ incoming, buffer, dirty })) {
      case "ignore":
        return;
      case "reload":
        buffer = incoming;
        setDirty(false);
        editor?.setDoc(incoming);
        return;
      case "conflict":
        conflict = incoming;
        return;
    }
  }

  onMount(async () => {
    await load();
    await backend.watchFileForViewer(path).catch(() => {});
    unlisten = await listen<string>("file-changed", (event) => {
      if (event.payload === path) void handleExternalChange();
    });
  });

  onDestroy(() => {
    unlisten?.();
    // Fire-and-forget: the component is going away, but an unsaved
    // buffer must still reach disk. Autosave caps the loss at ~1s anyway.
    if (dirty && editable) void backend.writeFileForEditor(path, buffer).catch(() => {});
    setPathDirty(path, false);
    if (saveTimer) clearTimeout(saveTimer);
    void backend.unwatchFileForViewer(path).catch(() => {});
  });
</script>

<div class="pane">
  <div class="modes">
    {#each availableModes as m (m)}
      <button
        type="button"
        class:active={effectiveMode === m}
        disabled={m === "edit" && !editable}
        title={m === "edit" && !editable ? "This file can't be edited" : ""}
        onclick={() => switchMode(m)}
      >
        {m === "formatted" ? "Formatted" : m === "plain" ? "Plain" : "Edit"}
      </button>
    {/each}
    {#if dirty}
      <span class="dirty" title="Unsaved changes">●</span>
    {/if}
  </div>

  {#if conflict !== null}
    <div class="notice error">
      This file changed on disk while you were editing.
      <button onclick={keepMine}>Keep mine</button>
      <button onclick={takeTheirs}>Take theirs</button>
    </div>
  {/if}
  {#if saveError !== null}
    <div class="notice error">Couldn't save: {saveError}</div>
  {/if}
  {#if openError !== null}
    <div class="notice error">Couldn't open externally: {openError}</div>
  {/if}

  {#if error !== null}
    <div class="overlay">
      <p>Couldn't open this file.</p>
      <p class="detail">{error}</p>
      <button onclick={openExternally}>Open externally</button>
    </div>
  {:else}
    {#if truncated}
      <div class="notice">
        This file is too large to preview in full — showing the first part only, and
        editing is disabled so saving can't truncate it.
        <button onclick={openExternally}>Open externally</button>
      </div>
    {/if}
    {#if !exists}
      <div class="notice">This file doesn't exist yet — saving will create it.</div>
    {/if}
    {#if effectiveMode === "formatted"}
      <div class="markdown">{@html rendered}</div>
    {:else if loaded}
      <div class="editor">
        <CodeMirrorView
          bind:this={editor}
          doc={buffer}
          {path}
          readOnly={effectiveMode !== "edit"}
          onChange={handleChange}
          onSave={saveNow}
        />
      </div>
    {/if}
  {/if}
</div>
```

Styles: paste `.pane` (minus the `.inactive` rules — visibility is the wrapper's job now), `.overlay`, `.detail`, `.notice`, `.notice.error`, `.overlay button`/`.notice button`, and the whole `.markdown` block from today's `FileViewerPane.svelte`, then add:

```css
  .pane {
    display: flex;
    flex-direction: column;
  }
  .modes {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    justify-content: flex-end;
    flex: 0 0 auto;
    border-bottom: 1px solid #2f2f2f;
  }
  .modes button {
    background: transparent;
    border: 1px solid transparent;
    color: #999;
    font-family: monospace;
    font-size: 0.75em;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .modes button.active {
    background: #333;
    color: #eee;
  }
  .modes button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .dirty {
    color: #d9a648;
    font-size: 0.7em;
    margin-left: 4px;
  }
  .editor {
    flex: 1 1 auto;
    min-height: 0;
  }
  .markdown {
    flex: 1 1 auto;
    overflow: auto;
  }
```

- [ ] **Step 3: Verify** — `npx svelte-check` 0 errors, `npx vitest run` still green (no new tests here — this is component code, which this repo does not unit-test).

- [ ] **Step 4: Commit** — `git add app/src/lib/CodeMirrorView.svelte app/src/lib/FileEditor.svelte && git commit -m "feat(editor): FileEditor with modes, autosave, and conflict handling"`

---

### Task 5: Pane wrapper, highlight.js removal, dirty dot

**Files:**
- Modify: `app/src/lib/FileViewerPane.svelte` (becomes a thin wrapper)
- Modify: `app/src/lib/fileTypes.ts`, `app/src/lib/fileTypes.test.ts`
- Modify: `app/package.json`
- Modify: `app/src/lib/Pane.svelte`

- [ ] **Step 1: Replace `FileViewerPane.svelte` entirely** with:

```svelte
<script lang="ts">
  import FileEditor from "./FileEditor.svelte";
  import { defaultMode } from "./fileEditing";

  let { path, visible }: { path: string; visible: boolean } = $props();

  let editor = $state<{ measure: () => void } | null>(null);

  // Pane.svelte's fitAll() calls fit() on every tab in a pane, terminal
  // or not. CodeMirror measures itself on mount, so a tab mounted while
  // hidden would render at zero height -- both this and the visibility
  // effect below exist to re-measure once it can actually be seen.
  export function fit(): void {
    editor?.measure();
  }

  $effect(() => {
    if (visible) editor?.measure();
  });
</script>

<div class="pane" class:inactive={!visible}>
  <FileEditor bind:this={editor} {path} initialMode={defaultMode(path, "tab")} />
</div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: #1e1e1e;
    color: #eee;
  }
  .inactive {
    visibility: hidden;
    z-index: 0;
  }
  .pane:not(.inactive) {
    z-index: 1;
  }
</style>
```

- [ ] **Step 2: Drop highlight.js.** It now has no importer: delete `fileLanguage` and `LANGUAGE_BY_EXTENSION` from `fileTypes.ts` (keep `fileExtension` and `isMarkdown`, and update the file's top comment, which currently describes the hljs map), delete the `fileLanguage` describe block from `fileTypes.test.ts` and its import, then `npm uninstall highlight.js`. Confirm nothing references it: `grep -rn "highlight.js\|hljs" app/src app/package.json` must come back empty.

- [ ] **Step 3: Dirty dot on file tabs** (`Pane.svelte`). Add to the imports:

```typescript
  import { dirtyPaths } from "./fileEditing";
```

and in the tab markup, immediately after the `tabStatusDot` block, add:

```svelte
        {#if fileTabPath(sessionId) && $dirtyPaths.has(fileTabPath(sessionId) ?? "")}
          <span class="dirty-dot" title="Unsaved changes"></span>
        {/if}
```

with the style:

```css
  .dirty-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
    background: #d9a648;
  }
```

- [ ] **Step 4: Verify** — `npx svelte-check` 0 errors, `npx vitest run` green (the `fileTypes` test file shrank), `npm run build` succeeds (catches a stale hljs import the type-checker would miss).

- [ ] **Step 5: Commit** — `git add app && git commit -m "refactor(editor): pane wrapper, drop highlight.js, dirty tab indicator"`

---

### Task 6: PRD + agent-file hub tabs, gating, checklist

**Files:**
- Create: `app/src/lib/PrdHubView.svelte`, `app/src/lib/AgentFileHubView.svelte`
- Modify: `app/src/lib/workspace.ts`, `app/src/lib/workspace.test.ts`
- Modify: `app/src/lib/workspaceViews.ts`
- Modify: `app/src/routes/+page.svelte`
- Modify: `app/src/lib/smokeChecklist.ts`

- [ ] **Step 1: The gating predicate** (`workspace.ts`, next to `showsDevOnlyViews`):

```typescript
// One place decides whether a hub view is offered, so the rule stays
// testable -- workspaceViews.ts imports Svelte components, which this
// project's vitest setup cannot process.
export function hubViewIsVisible(
  view: { devOnly?: boolean; requiresRoot?: boolean },
  workspaceId: string,
  isDev: boolean,
  hasRoot: boolean
): boolean {
  if (view.devOnly && !showsDevOnlyViews(workspaceId, isDev)) return false;
  if (view.requiresRoot && !hasRoot) return false;
  return true;
}
```

- [ ] **Step 2: Its tests** (append to `workspace.test.ts`, extending the existing import list):

```typescript
describe("hubViewIsVisible", () => {
  it("always shows a plain view", () => {
    expect(hubViewIsVisible({}, "ws-1", false, false)).toBe(true);
  });

  it("hides a root-requiring view until a root is bound", () => {
    expect(hubViewIsVisible({ requiresRoot: true }, "ws-1", true, false)).toBe(false);
    expect(hubViewIsVisible({ requiresRoot: true }, "ws-1", true, true)).toBe(true);
  });

  it("keeps the dev-only rule", () => {
    expect(hubViewIsVisible({ devOnly: true }, SMOKETEST_WORKSPACE_ID, true, false)).toBe(true);
    expect(hubViewIsVisible({ devOnly: true }, "ws-1", true, true)).toBe(false);
  });
});
```

- [ ] **Step 3: The two hub views.** `PrdHubView.svelte`:

```svelte
<script lang="ts">
  import { layoutState } from "./layoutState";
  import FileEditor from "./FileEditor.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  const path = $derived(root ? `${root}/.gavin-root/PRD.md` : null);
</script>

{#if path}
  {#key path}
    <FileEditor {path} initialMode="edit" />
  {/key}
{:else}
  <div class="empty">No root folder set for this workspace.</div>
{/if}

<style>
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
  }
</style>
```

`AgentFileHubView.svelte` is identical except for the path line and its comment:

```svelte
  // CLAUDE.md is hardcoded rather than read from config: it is the only
  // agent profile that exists (D4's seam lives in agent_setup.rs's
  // ClaudeCodeProfile), and a lookup for a single value would be
  // speculative.
  const path = $derived(root ? `${root}/CLAUDE.md` : null);
```

(The `{#key path}` wrapper matters: switching workspaces must rebuild the editor against the new file rather than leave the old buffer mounted.)

- [ ] **Step 4: Register the views** (`workspaceViews.ts`): add `requiresRoot?: boolean` to the `HubView` interface, import `FileText` and `Bot` from `@lucide/svelte` plus both components, add the entries after `kanban`:

```typescript
  { id: "prd", label: "PRD", icon: FileText, component: PrdHubView, requiresRoot: true },
  { id: "agent-file", label: "CLAUDE.md", icon: Bot, component: AgentFileHubView, requiresRoot: true },
```

and rewrite the filter to delegate:

```typescript
export function visibleHubViews(workspaceId: string, isDev: boolean, hasRoot: boolean): HubView[] {
  return HUB_VIEWS.filter((v) => hubViewIsVisible(v, workspaceId, isDev, hasRoot));
}
```

(importing `hubViewIsVisible` instead of `showsDevOnlyViews`).

- [ ] **Step 5: Pass `hasRoot`** (`+page.svelte`, line ~30):

```svelte
  const hubViews = $derived(
    visibleHubViews(activeWorkspace?.id ?? "", import.meta.env.DEV, Boolean(activeWorkspace?.rootPath))
  );
```

- [ ] **Step 6: Checklist section** — add to `SMOKE_SECTIONS` in `smokeChecklist.ts`, after "Plans on the board":

```typescript
  {
    title: "Markdown editing",
    items: [
      { id: "edit-modes", text: "A markdown file tab offers Formatted / Plain / Edit; a .rs file offers Plain / Edit" },
      { id: "edit-autosave", text: "Type in Edit, wait ~1s, check the file on disk — the change is there" },
      { id: "edit-save-key", text: "⌘S saves immediately; the tab's dirty dot clears" },
      {
        id: "edit-external-clean",
        text: "Edit the file in a terminal while the editor is clean → it reloads silently",
      },
      {
        id: "edit-conflict",
        text: "Type (don't wait), then edit the same file externally → conflict banner; both buttons behave",
        hint: "Keep mine = your text wins on the next save; Take theirs = buffer is replaced.",
      },
      { id: "edit-plan-card", text: "Editing a plan's status: line here moves its card on the board (~3s)" },
      { id: "edit-truncated", text: "A >1 MB file offers no Edit mode and says why" },
      { id: "edit-hub-tabs", text: "PRD and CLAUDE.md tabs appear only with a root bound, and open in Edit" },
      { id: "edit-creates", text: "With no CLAUDE.md, its tab opens empty and the first save creates the file" },
      { id: "edit-hidden-pane", text: "Open a file tab, switch to a sibling tab and back — the editor is full height, not collapsed" },
    ],
  },
```

- [ ] **Step 7: Full verification** — `cargo test` (all crates), `npx vitest run`, `npx svelte-check` (0 errors), `npm run build`.

- [ ] **Step 8: Manual smoke** — run through the new checklist section in the dev Smoke Test workspace. Present results; do not claim a pass you did not observe.

- [ ] **Step 9: Commit** — `git add app && git commit -m "feat(editor): PRD and agent-file hub tabs with root gating"`

---

## Testing summary

- Frontend unit: 3 `codeMirror.ts` cases, 6 `fileEditing.ts` describes (~13 cases), 3 `hubViewIsVisible` cases; `fileTypes.test.ts` shrinks with `fileLanguage`.
- Rust: 4 new `fileviewer.rs` tests, 2 existing literals updated.
- Components (`CodeMirrorView`, `FileEditor`, both hub views): manual only, per this repo's convention — covered by the new checklist section.

## Out of scope

LSP, linting, formatting (D23); creating/renaming/deleting files (sub-5); the Mission Control layout (sub-6); additional agent profiles.
