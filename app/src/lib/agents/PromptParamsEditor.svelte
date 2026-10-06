<script lang="ts">
  /// An add/remove list of single lines: an agent's extra prompt-text
  /// lines, or its extra CLI arguments. One component for both because
  /// they are the same control over the same data shape (`string[]` per
  /// primary agent), and for both panels -- the app-wide Settings page and
  /// a workspace's Settings tab.
  ///
  /// Purely presentational. It renders the list it is handed and reports
  /// the whole next list on commit; where the list is STORED, and what
  /// inheriting means, is the caller's business (`promptParams.ts`).
  ///
  /// A row commits on blur or Enter, not per keystroke: each commit is a
  /// config write, and a half-typed CLI flag is not worth one. The row
  /// being added exists only in `draft` until something is typed into it,
  /// so an "Add" followed by a click elsewhere leaves nothing behind
  /// (blank lines are never stored).
  import { sanitizeList } from "$lib/agents/promptParams";

  interface Props {
    items: readonly string[];
    placeholder: string;
    addLabel: string;
    /// Label for the control group, for assistive tech.
    label: string;
    disabled?: boolean;
    onChange: (items: string[]) => void;
  }
  let { items, placeholder, addLabel, label, disabled = false, onChange }: Props = $props();

  /// The list being edited when it differs from the stored one: a row
  /// just added, or text typed but not yet committed. Null means "show
  /// what is stored".
  let draft = $state<string[] | null>(null);
  const rows = $derived(draft ?? [...items]);

  function setAt(index: number, value: string): void {
    const next = [...rows];
    next[index] = value;
    draft = next;
  }

  function commit(): void {
    if (draft === null) return;
    const next = sanitizeList(draft);
    draft = null;
    // Unchanged after cleaning (a blank row abandoned, an edit reverted):
    // no write.
    if (next.length === items.length && next.every((line, i) => line === items[i])) return;
    onChange(next);
  }

  function removeAt(index: number): void {
    draft = null;
    onChange(sanitizeList(rows.filter((_, i) => i !== index)));
  }

  function addRow(): void {
    draft = [...rows, ""];
  }
</script>

<div class="params" role="group" aria-label={label}>
  {#each rows as line, i (i)}
    <div class="line">
      <input
        spellcheck="false"
        autocomplete="off"
        {placeholder}
        {disabled}
        value={line}
        aria-label="{label} {i + 1}"
        oninput={(e) => setAt(i, e.currentTarget.value)}
        onblur={commit}
        onkeydown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <button type="button" class="ghost" {disabled} onclick={() => removeAt(i)}>Remove</button>
    </div>
  {/each}
  <button type="button" class="ghost add" {disabled} onclick={addRow}>{addLabel}</button>
</div>

<style>
  .params {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin-bottom: 8px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .line input {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
  }
  .ghost {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
  }
  .ghost:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
