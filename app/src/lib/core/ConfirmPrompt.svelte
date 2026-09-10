<script lang="ts">
  import Modal from "$lib/core/Modal.svelte";

  interface Choice {
    label: string;
    danger?: boolean;
    // True when this choice consumes the picker's value: disabled while
    // the picker has nothing to offer.
    needsPick?: boolean;
    // `checked` is the tick-box's value, false whenever the prompt has
    // no tick-box -- every existing choice simply ignores the argument.
    onPick: (picked: string | null, checked: boolean) => void;
  }

  interface PickerOption {
    value: string;
    label: string;
  }

  interface Props {
    title: string;
    // Consequence lines, rendered as a list -- spell out exactly what
    // will happen (files deleted, tasks un-parented, sessions kept).
    lines: string[];
    // Optional destination picker (e.g. where a deleted column's cards
    // should go); its value is handed to the chosen action.
    picker?: { label: string; options: PickerOption[] } | null;
    // A variation on the one action ("also delete the merged
    // branches"), so a flow with a follow-up question asks once. Never
    // a second "are you sure": the title still has to describe what the
    // confirm button does with the box left alone.
    check?: { label: string; default?: boolean } | null;
    // Text the reader has to see byte for byte, in a scrollable
    // monospace box under the lines. For the first-Run card review,
    // where the whole question is "is this the prompt you meant to
    // send" -- a rendered or summarised form would defeat it, so this
    // is plain text and stays plain text.
    block?: { label: string; text: string } | null;
    choices: Choice[];
    // The dismissing button's word. "Cancel" reads right when the other
    // answer is the action, but some prompts have two actions and no
    // way out ("Restore" / "Start fresh") -- there, "Cancel" would lie
    // about what the button does.
    cancelLabel?: string;
    onCancel: () => void;
  }
  let {
    title,
    lines,
    picker = null,
    check = null,
    block = null,
    choices,
    cancelLabel = "Cancel",
    onCancel,
  }: Props = $props();

  let picked = $state<string | null>(null);
  let checked = $state(check?.default ?? false);
  let cancelButton = $state<HTMLButtonElement | null>(null);
  let choiceButtons = $state<Array<HTMLButtonElement | null>>([]);

  // Focus lands INSIDE the modal, on the answer that is safe to give by
  // reflex: the last choice when it is harmless, the dismissing button
  // whenever the prompt is destructive. That is the platform
  // convention, and it is the reason Enter can be trusted here at all --
  // every destructive prompt in the app marks its choice `danger`, so
  // Enter dismisses those rather than firing them.
  const enterIsSafe = $derived(choices.length > 0 && !choices.some((c) => c.danger));
  // Once, on the first render that has a button to aim at -- not on
  // every re-run of the effect, or a later state change would yank focus
  // back out of wherever the human had moved it.
  let focusTaken = false;
  let focusWasOn: Element | null = null;
  $effect(() => {
    if (focusTaken) return;
    const target = enterIsSafe ? choiceButtons[choices.length - 1] : cancelButton;
    if (!target) return;
    focusTaken = true;
    focusWasOn = document.activeElement;
    target.focus();
  });
  // Handed back on teardown: a prompt raised over a surface the human was
  // typing in (the card detail's editor) must not swallow the caret on
  // its way out.
  $effect(() => () => {
    if (focusWasOn instanceof HTMLElement && focusWasOn.isConnected) focusWasOn.focus();
  });

  // Defaulted in an effect rather than at declaration: reading `picker`
  // once would freeze the first render's value.
  $effect(() => {
    if (picked === null && picker && picker.options.length > 0) picked = picker.options[0].value;
  });
</script>

<Modal onClose={onCancel}>
  <div class="title">{title}</div>
  <ul class="lines">
    {#each lines as line, i (i)}
      <li>{line}</li>
    {/each}
  </ul>
  {#if picker && picker.options.length > 0}
    <label class="picker">
      <span>{picker.label}</span>
      <select bind:value={picked}>
        {#each picker.options as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
  {/if}
  {#if block}
    <div class="block-label">{block.label}</div>
    <pre class="block">{block.text}</pre>
  {/if}
  {#if check}
    <label class="check"><input type="checkbox" bind:checked /> {check.label}</label>
  {/if}
  <div class="actions">
    <button type="button" bind:this={cancelButton} onclick={onCancel}>{cancelLabel}</button>
    {#each choices as choice, i (choice.label)}
      <button
        type="button"
        bind:this={choiceButtons[i]}
        class:danger={choice.danger}
        disabled={choice.needsPick && picked === null}
        onclick={() => choice.onPick(picked, checked)}
      >
        {choice.label}
      </button>
    {/each}
  </div>
</Modal>

<style>
  .title {
    font-family: monospace;
    font-weight: bold;
    color: var(--text);
    margin-bottom: 10px;
  }
  .lines {
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text-muted);
    margin: 0 0 14px;
    padding-left: 18px;
  }
  .lines li {
    margin-bottom: 4px;
  }
  .block-label {
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  /* Scrolls in BOTH directions and wraps nothing: a prompt is read as
     the agent gets it, and a soft-wrapped line hides where the real
     newlines are. Capped so the buttons stay on screen for a long body
     -- the panel's own 80vh cap would otherwise push them off. */
  .block {
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    margin: 0 0 14px;
    max-height: 40vh;
    overflow: auto;
    white-space: pre;
    tab-size: 2;
  }
  .picker {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text-muted);
    margin-bottom: 14px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text-muted);
    margin-bottom: 14px;
    cursor: pointer;
  }
  .picker select {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    padding: 3px 6px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .actions button:focus-visible {
    outline: 2px solid var(--border-accent);
    outline-offset: 1px;
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button.danger {
    background: var(--surface-danger);
    color: var(--danger-text);
  }
  .actions button.danger:hover {
    background: var(--surface-danger);
  }
</style>
