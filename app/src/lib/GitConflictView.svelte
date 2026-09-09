<script lang="ts">
  import { onDestroy } from "svelte";
  import { ChevronUp, ChevronDown, Save, Check, Undo2, Wrench, Columns3 } from "@lucide/svelte";
  import { gitStore, saveConflict, markResolved, resolveWhole, restoreConflict, openMergeTool } from "$lib/gitState";
  import { parseConflicts, applyChoice, hasMarkers, locateRegion, splitEol, joinEol, type Choice, type ConflictBlock } from "$lib/conflictMarkers";
  import { createEditor, type EditorHandle } from "$lib/codeMirror";
  import { themeState } from "$lib/ui/themeState.svelte";
  import { createRegionDecorations, type Region, type RegionDecorations } from "$lib/mergeDecorations";
  import { tooltip } from "$lib/tooltip";
  import GitConflictChooser from "$lib/GitConflictChooser.svelte";
  import GitDiscardDialog from "$lib/GitDiscardDialog.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const MAX_BYTES = 2 * 1024 * 1024;

  const view = $derived($gitStore[workspaceId] ?? null);
  const conflict = $derived(view?.conflict ?? null);
  const locked = $derived(view == null || view.busy != null || view.op != null);
  const mergeTool = $derived(view?.mergeTool ?? null);
  const isText = $derived(conflict?.kind === "text" || (conflict?.kind === "addedBoth" && conflict.ours !== null && conflict.theirs !== null));
  const tooLarge = $derived(
    !!conflict && [conflict.base, conflict.ours, conflict.theirs, conflict.worktree].some((t) => (t?.length ?? 0) > MAX_BYTES)
  );

  // ---- the Result document is the file with markers (spec §1) -------------
  let doc = $state("");
  let dirty = $state(false);
  let loadedFor = $state<string | null>(null); // path + token the doc was loaded from
  let showBase = $state(false);
  let active = $state(0);

  const blocks = $derived(parseConflicts(doc));
  const markers = $derived(hasMarkers(doc));

  // Pane editors.
  let oursEl = $state<HTMLElement | null>(null);
  let baseEl = $state<HTMLElement | null>(null);
  let theirsEl = $state<HTMLElement | null>(null);
  let resultEl = $state<HTMLElement | null>(null);
  type Pane = { handle: EditorHandle; deco: RegionDecorations };
  let panes = $state<{ ours?: Pane; base?: Pane; theirs?: Pane; result?: Pane }>({});

  async function mount(el: HTMLElement, key: keyof typeof panes, text: string, readOnly: boolean): Promise<void> {
    const deco = await createRegionDecorations();
    const handle = await createEditor({
      parent: el,
      doc: text,
      path: conflict?.path ?? "file.txt",
      readOnly,
      theme: themeState.effective,
      extensions: [deco.extension],
      onChange: (value) => {
        if (key !== "result") return;
        if (value !== doc) {
          doc = value;
          dirty = true;
        }
      },
      onSave: () => void save(),
    });
    panes = { ...panes, [key]: { handle, deco } };
  }

  // All four panes reconfigure in place rather than remounting, so a theme
  // flip mid-merge keeps scroll position, undo history and any unsaved
  // resolution in the result pane.
  $effect(() => {
    const t = themeState.effective;
    for (const pane of Object.values(panes)) pane?.handle.setTheme(t);
  });

  // (Re)load when a different conflict arrives (selection change or a
  // refresh after save/restore): the on-disk text is authoritative.
  $effect(() => {
    const c = conflict;
    const key = c ? `${c.path}:${view?.conflictToken}` : null;
    if (!c || !isText || key === loadedFor) return;
    loadedFor = key;
    doc = c.worktree ?? c.theirs ?? c.ours ?? "";
    dirty = false;
    active = 0;
    panes.result?.handle.setDoc(doc);
    panes.ours?.handle.setDoc(c.ours ?? "");
    panes.base?.handle.setDoc(c.base ?? "");
    panes.theirs?.handle.setDoc(c.theirs ?? "");
  });

  // Mount editors when their containers appear.
  $effect(() => {
    if (oursEl && !panes.ours) void mount(oursEl, "ours", conflict?.ours ?? "", true);
  });
  $effect(() => {
    if (theirsEl && !panes.theirs) void mount(theirsEl, "theirs", conflict?.theirs ?? "", true);
  });
  $effect(() => {
    if (resultEl && !panes.result) void mount(resultEl, "result", doc, false);
  });
  $effect(() => {
    if (baseEl && !panes.base) void mount(baseEl, "base", conflict?.base ?? "", true);
    if (!baseEl && panes.base) {
      panes.base.handle.destroy();
      const { base: _b, ...rest } = panes;
      panes = rest;
    }
  });
  onDestroy(() => {
    for (const p of Object.values(panes)) p?.handle.destroy();
  });

  // ---- decorations ---------------------------------------------------------
  function choose(block: ConflictBlock, choice: Choice): void {
    if (locked) return;
    doc = applyChoice(doc, block, choice);
    dirty = true;
    panes.result?.handle.setDoc(doc);
  }

  const regions = $derived.by(() => {
    const c = conflict;
    const result: Region[] = [];
    const ours: Region[] = [];
    const base: Region[] = [];
    const theirs: Region[] = [];
    let oursAt = 0;
    let baseAt = 0;
    let theirsAt = 0;
    for (const b of blocks) {
      const isActive = b.index === active;
      result.push({
        from: b.from,
        to: b.to,
        cls: "cm-conflict",
        index: b.index + 1,
        active: isActive,
        actions: [
          { label: "Ours", title: `Take ${c?.labels.ours ?? "ours"}`, onPick: () => choose(b, "ours") },
          { label: "Theirs", title: `Take ${c?.labels.theirs ?? "theirs"}`, onPick: () => choose(b, "theirs") },
          { label: "Both", title: "Ours then theirs", onPick: () => choose(b, "both") },
          { label: "Both ⇅", title: "Theirs then ours", onPick: () => choose(b, "both-reverse") },
        ],
      });
      const o = c?.ours ? locateRegion(c.ours, b.ours, oursAt) : null;
      if (o) {
        ours.push({ ...o, cls: "cm-side-ours", index: b.index + 1, active: isActive });
        oursAt = o.to;
      }
      const t = c?.theirs ? locateRegion(c.theirs, b.theirs, theirsAt) : null;
      if (t) {
        theirs.push({ ...t, cls: "cm-side-theirs", index: b.index + 1, active: isActive });
        theirsAt = t.to;
      }
      const bs = c?.base && b.base ? locateRegion(c.base, b.base, baseAt) : null;
      if (bs) {
        base.push({ ...bs, cls: "cm-side-base", index: b.index + 1, active: isActive });
        baseAt = bs.to;
      }
    }
    return { result, ours, base, theirs };
  });

  $effect(() => {
    const r = regions;
    panes.result?.deco.setRegions(panes.result.handle, r.result);
    panes.ours?.deco.setRegions(panes.ours.handle, r.ours);
    panes.theirs?.deco.setRegions(panes.theirs.handle, r.theirs);
    panes.base?.deco.setRegions(panes.base.handle, r.base);
  });

  // ---- navigation ----------------------------------------------------------
  function goTo(i: number): void {
    if (blocks.length === 0) return;
    active = ((i % blocks.length) + blocks.length) % blocks.length;
    const b = blocks[active];
    panes.result?.handle.scrollToLine(b.from);
    const o = regions.ours[active];
    if (o) panes.ours?.handle.scrollToLine(o.from);
    const t = regions.theirs[active];
    if (t) panes.theirs?.handle.scrollToLine(t.from);
    const bs = regions.base[active];
    if (bs) panes.base?.handle.scrollToLine(bs.from);
  }

  // ---- actions -------------------------------------------------------------
  async function save(): Promise<void> {
    if (!conflict || !dirty || locked) return;
    const parts = splitEol(doc);
    const ok = await saveConflict(workspaceId, joinEol(parts.lines, conflict.eol, conflict.finalNewline));
    if (ok) dirty = false;
  }

  const canMark = $derived(!!conflict && !dirty && !markers && !locked);

  let confirm = $state<{ title: string; body: string; label: string; run: () => void } | null>(null);
  function ask(title: string, body: string, label: string, run: () => void): void {
    confirm = { title, body, label, run };
  }
  function runConfirm(): void {
    const c = confirm;
    confirm = null;
    c?.run();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.metaKey && e.key === "Enter") {
      e.preventDefault();
      if (canMark) void markResolved(workspaceId);
    } else if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      goTo(active + 1);
    } else if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      goTo(active - 1);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="conflict" role="region" aria-label="Merge editor" onkeydown={onKeydown}>
  {#if !conflict}
    <div class="msg">Loading conflict…</div>
  {:else}
    <div class="head">
      <span class="path" title={conflict.path}>{conflict.path}</span>
      <span class="kind">{conflict.kind}</span>
      {#if isText && !tooLarge}
        <span class="nav">
          <button type="button" use:tooltip={"Previous conflict (⌥↑)"} disabled={blocks.length === 0} onclick={() => goTo(active - 1)}><ChevronUp size={12} /></button>
          <span class="counter">{blocks.length === 0 ? "no conflicts" : `${active + 1} of ${blocks.length}`}</span>
          <button type="button" use:tooltip={"Next conflict (⌥↓)"} disabled={blocks.length === 0} onclick={() => goTo(active + 1)}><ChevronDown size={12} /></button>
        </span>
        <button type="button" class="act" class:on={showBase} use:tooltip={"Show the common ancestor"} onclick={() => (showBase = !showBase)}><Columns3 size={12} /> Base</button>
      {/if}
      <span class="spacer"></span>
      {#if conflict.kind !== "deleteModify"}
        <button type="button" class="act" disabled={locked} onclick={() => ask(`Use ${conflict.labels.ours}'s version of ${conflict.path}?`, "The whole file is replaced and marked resolved.", "Use ours", () => void resolveWhole(workspaceId, "ours"))}>Use ours</button>
        <button type="button" class="act" disabled={locked} onclick={() => ask(`Use ${conflict.labels.theirs}'s version of ${conflict.path}?`, "The whole file is replaced and marked resolved.", "Use theirs", () => void resolveWhole(workspaceId, "theirs"))}>Use theirs</button>
      {/if}
      <button type="button" class="act" disabled={locked} use:tooltip={"git checkout -m: recreate the conflict markers from the index"} onclick={() => ask(`Restore conflict markers in ${conflict.path}?`, "Your edits to this file are replaced by git's original conflict text.", "Restore", () => void restoreConflict(workspaceId))}><Undo2 size={12} /> Restore markers</button>
      {#if mergeTool}
        <button type="button" class="act" disabled={locked} use:tooltip={`git mergetool (${mergeTool}) in a terminal pane`} onclick={() => openMergeTool(workspaceId)}><Wrench size={12} /> Open in {mergeTool}</button>
      {/if}
      {#if isText && !tooLarge}
        <button type="button" class="act" disabled={!dirty || locked} use:tooltip={"⌘S"} onclick={save}><Save size={12} /> Save</button>
      {/if}
      <button
        type="button"
        class="primary"
        disabled={!canMark}
        use:tooltip={dirty ? "Save first" : markers ? "Conflict markers remain" : "⌘Enter — git add"}
        onclick={() => markResolved(workspaceId)}
      ><Check size={12} /> Mark resolved</button>
    </div>

    {#if !isText}
      <GitConflictChooser {workspaceId} {conflict} {locked} />
    {:else if tooLarge}
      <div class="msg">This file is larger than 2 MB — use <b>Use ours</b> / <b>Use theirs</b>{mergeTool ? ` or Open in ${mergeTool}` : ""}.</div>
    {:else}
      <div class="panes" class:with-base={showBase}>
        <div class="pane">
          <div class="label ours">{conflict.labels.ours}</div>
          <div class="editor" bind:this={oursEl}></div>
        </div>
        {#if showBase}
          <div class="pane">
            <div class="label base">base</div>
            <div class="editor" bind:this={baseEl}></div>
          </div>
        {/if}
        <div class="pane">
          <div class="label theirs">{conflict.labels.theirs}</div>
          <div class="editor" bind:this={theirsEl}></div>
        </div>
        <div class="pane result">
          <div class="label">Result{dirty ? " — unsaved" : markers ? "" : " — resolved"}</div>
          <div class="editor" bind:this={resultEl}></div>
        </div>
      </div>
    {/if}
  {/if}
</div>

{#if confirm}
  <GitDiscardDialog title={confirm.title} body={confirm.body} offerSkip={false} confirmLabel={confirm.label} onConfirm={runConfirm} onCancel={() => (confirm = null)} />
{/if}

<style>
  .conflict {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-sunken);
    font-family: monospace;
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 0.76em;
    flex-wrap: wrap;
  }
  .path {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 30ch;
  }
  .kind {
    color: var(--warning-text);
    border: 1px solid var(--border-warning);
    border-radius: 8px;
    padding: 0 6px;
    font-size: 0.9em;
  }
  .nav {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .nav button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    width: 20px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .nav button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .counter {
    color: var(--text-muted);
    padding: 0 4px;
    white-space: nowrap;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .act,
  .primary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 1em;
    padding: 2px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .act:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .act.on {
    background: var(--surface-accent);
    color: var(--text);
  }
  .primary {
    background: var(--surface-success);
    border-color: var(--border-success);
    color: var(--success-text);
  }
  .act:disabled,
  .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .panes {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1px;
    background: var(--surface-raised);
  }
  .panes.with-base {
    grid-template-columns: 1fr 1fr 1fr;
  }
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface-sunken);
  }
  .pane.result {
    grid-column: 1 / -1;
  }
  .label {
    padding: 3px 8px;
    font-size: 0.72em;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }
  .label.ours {
    color: var(--success-text);
  }
  .label.theirs {
    color: var(--accent-text);
  }
  .label.base {
    color: var(--warning-text);
  }
  .editor {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .editor :global(.cm-editor) {
    height: 100%;
  }
  .editor :global(.cm-scroller) {
    overflow: auto;
  }
  .editor :global(.cm-conflict) {
    background: rgba(217, 180, 92, 0.12);
  }
  .editor :global(.cm-conflict.active) {
    background: rgba(217, 180, 92, 0.22);
  }
  .editor :global(.cm-side-ours) {
    background: rgba(139, 201, 139, 0.14);
  }
  .editor :global(.cm-side-theirs) {
    background: rgba(138, 180, 224, 0.14);
  }
  .editor :global(.cm-side-base) {
    background: rgba(217, 180, 92, 0.1);
  }
  .editor :global(.cm-side-ours.active),
  .editor :global(.cm-side-theirs.active),
  .editor :global(.cm-side-base.active) {
    filter: brightness(1.35);
  }
  .editor :global(.cm-conflict-badge) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 6px;
    vertical-align: middle;
  }
  /* The one place a component reaches tier 1 on purpose. --text-inverted
     is white, which is the right foreground on --accent and --danger but
     only 2.2:1 on amber -- and amber is light in BOTH themes, so this
     badge's foreground is a constant dark rather than a theme-flipped
     one. The vocabulary has no per-family on-fill foreground; noted as an
     open item rather than inventing a family of four for one badge. */
  .editor :global(.cm-conflict-num) {
    background: var(--warning);
    color: var(--grey-0);
    border-radius: 8px;
    padding: 0 6px;
    font-size: 0.75em;
    font-weight: 700;
  }
  .editor :global(.cm-conflict-badge.active .cm-conflict-num) {
    background: var(--amber-4);
  }
  .editor :global(.cm-conflict-act) {
    background: var(--surface-accent);
    border: 1px solid var(--border-accent);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.75em;
    padding: 0 6px;
    cursor: pointer;
  }
  .editor :global(.cm-conflict-act:hover) {
    border-color: var(--border-accent);
  }
  .msg {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-subtle);
    font-size: 0.8em;
    gap: 4px;
  }
</style>
