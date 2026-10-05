<script lang="ts">
  // A setting that is on or off: the whole row is the target, as a phone's
  // own settings make it.
  interface Props {
    label: string;
    checked: boolean;
    disabled?: boolean;
    hint?: string | null;
    warn?: string | null;
    onChange: (checked: boolean) => void;
  }
  let { label, checked, disabled = false, hint = null, warn = null, onChange }: Props = $props();
</script>

<div class="toggle">
  <label class="row" class:disabled>
    <input type="checkbox" {checked} {disabled} onchange={(e) => onChange(e.currentTarget.checked)} />
    <span>{label}</span>
  </label>
  {#if warn}<p class="warn">{warn}</p>{/if}
  {#if hint}<p class="hint">{hint}</p>{/if}
</div>

<style>
  .toggle {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    color: var(--text);
    font-size: 0.875rem;
  }
  .row.disabled {
    opacity: 0.5;
  }
  input {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    margin: 0;
    accent-color: var(--accent);
  }
  .hint,
  .warn {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.45;
  }
  .hint {
    color: var(--text-subtle);
  }
  .warn {
    color: var(--warning-text);
  }
</style>
