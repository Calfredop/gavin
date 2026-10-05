<script lang="ts">
  // A model (or an effort) picker as the desk's panels draw one: the value
  // it inherits, the profile's presets, and "Custom…", which opens a box
  // for a name the presets do not list. The rows are the desk's own
  // (`modelOptions`, `effortOptions`), and so is the rule for when the box
  // shows (`modelIsCustom`) and when a typed value is written
  // (`fieldCommit`).
  import { CUSTOM_MODEL, modelIsCustom, type ModelOption } from "$lib/agents/agentModel";
  import { fieldCommit } from "$lib/core/settings";

  interface Props {
    id: string;
    options: ModelOption[];
    /// What is set of its own, "" when inheriting.
    own: string;
    presets: readonly string[];
    placeholder: string;
    disabled?: boolean;
    /// "" clears the value back to inheriting.
    onPick: (value: string) => void;
  }
  let { id, options, own, presets, placeholder, disabled = false, onPick }: Props = $props();

  let boxOpen = $state(false);
  let draft = $state("");
  let typing = $state(false);

  const custom = $derived(modelIsCustom(boxOpen, own, presets));

  // A value set elsewhere -- at the desk -- shows, unless the box is being
  // typed in: a push must not overwrite a field mid-word.
  $effect(() => {
    const value = own;
    if (!typing) draft = value;
  });

  function pick(value: string): void {
    if (value === CUSTOM_MODEL) {
      boxOpen = true;
      draft = own;
      return;
    }
    boxOpen = false;
    onPick(value);
  }

  function commit(): void {
    typing = false;
    const next = fieldCommit(draft, own, { empty: "clear" });
    if (next.kind === "write") onPick(next.value);
  }
</script>

<select {id} value={custom ? CUSTOM_MODEL : own} {disabled} onchange={(e) => pick(e.currentTarget.value)}>
  {#each options as option (option.value)}
    <option value={option.value}>{option.label}</option>
  {/each}
</select>
{#if custom}
  <input
    bind:value={draft}
    spellcheck="false"
    autocapitalize="off"
    autocomplete="off"
    {placeholder}
    {disabled}
    onfocus={() => (typing = true)}
    onblur={commit}
    onkeydown={(e) => {
      if (e.key === "Enter") e.currentTarget.blur();
    }}
  />
{/if}
