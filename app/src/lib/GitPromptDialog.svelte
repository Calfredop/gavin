<script module lang="ts">
  export interface PromptField {
    key: string;
    label: string;
    value: string;
    placeholder?: string;
    /// When set, renders a <select> instead of a text input.
    options?: string[];
    required?: boolean;
  }
</script>

<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Props {
    title: string;
    fields: PromptField[];
    checkbox?: { label: string; checked: boolean };
    primary: string;
    onSubmit: (values: Record<string, string>, checked: boolean) => void;
    onCancel: () => void;
  }
  let { title, fields, checkbox, primary, onSubmit, onCancel }: Props = $props();

  // The dialog is mounted fresh per prompt, so the initial field values are
  // exactly what we want to capture here.
  // svelte-ignore state_referenced_locally
  let values = $state<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, f.value])));
  // svelte-ignore state_referenced_locally
  let checked = $state(checkbox?.checked ?? false);

  const valid = $derived(fields.every((f) => !f.required || (values[f.key] ?? "").trim().length > 0));

  function submit(): void {
    if (!valid) return;
    onSubmit(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])), checked);
  }

</script>

<Modal onClose={onCancel}>
  <form class="prompt" onsubmit={(e) => { e.preventDefault(); submit(); }}>
    <h3>{title}</h3>
    {#each fields as field (field.key)}
      <label class="field">
        <span>{field.label}</span>
        {#if field.options}
          <select bind:value={values[field.key]}>
            {#each field.options as opt (opt)}
              <option value={opt}>{opt}</option>
            {/each}
          </select>
        {:else}
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" bind:value={values[field.key]} placeholder={field.placeholder ?? ""} autofocus={field === fields[0]} />
        {/if}
      </label>
    {/each}
    {#if checkbox}
      <label class="check"><input type="checkbox" bind:checked /> {checkbox.label}</label>
    {/if}
    <div class="actions">
      <button type="button" onclick={onCancel}>Cancel</button>
      <button type="submit" class="primary" disabled={!valid}>{primary}</button>
    </div>
  </form>
</Modal>

<style>
  .prompt {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 320px;
  }
  h3 {
    margin: 0;
    font-size: 1em;
    color: #eee;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8em;
    color: #999;
  }
  .field input,
  .field select {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    color: #ddd;
    font-family: monospace;
    font-size: 1em;
    padding: 5px 8px;
  }
  .field input:focus,
  .field select:focus {
    outline: none;
    border-color: #4a6a8a;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #999;
    font-size: 0.8em;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .actions button {
    background: #333;
    border: 1px solid #444;
    border-radius: 6px;
    color: #ddd;
    padding: 5px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .actions .primary {
    background: #2d4a2d;
    border-color: #3f6b3f;
    color: #cfe8cf;
  }
  .actions .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
