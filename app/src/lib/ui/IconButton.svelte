<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { tooltip as tooltipAction } from "../tooltip";

  type Variant = "bare" | "outlined" | "filled" | "segmented";
  type Tone = "default" | "accent" | "danger" | "success" | "warning";

  interface Props {
    /// A lucide icon component.
    icon: Component<{ size?: number }>;
    /// Drives aria-label AND the tooltip. Required, because before this
    /// component existed some of these buttons had aria-label, some had
    /// title, and some had neither.
    label: string;
    /// Optional visible text beside the icon.
    text?: string;
    /// Anything after the text -- an ahead/behind count, a stash badge.
    children?: Snippet;
    variant?: Variant;
    tone?: Tone;
    size?: number;
    active?: boolean;
    disabled?: boolean;
    /// Overrides `label` as the tooltip when the two should differ (e.g.
    /// a disabled button explaining WHY it is disabled). `null` opts out
    /// of the tooltip entirely without losing the aria-label.
    tip?: string | null;
    /// Extra classes for positioning by the host -- margins, grid
    /// placement, opacity-reveal on parent hover. Appearance belongs to
    /// the variant; the host only ever says WHERE the button sits.
    class?: string;
    [key: string]: unknown;
  }

  let {
    icon: Icon,
    label,
    text,
    children,
    variant = "bare",
    tone = "default",
    size = 12,
    active = false,
    disabled = false,
    tip,
    class: extraClass = "",
    ...rest
  }: Props = $props();

  const tipText = $derived(tip === undefined ? label : tip);
</script>

<button
  type="button"
  class="icon-button {variant} tone-{tone} {extraClass}"
  class:active
  aria-label={label}
  aria-pressed={active ? true : undefined}
  {disabled}
  use:tooltipAction={tipText}
  {...rest}
>
  <Icon {size} />
  {#if text}<span class="text">{text}</span>{/if}
  {@render children?.()}
</button>

<style>
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    box-sizing: border-box;
    font-family: inherit;
    font-size: inherit;
    line-height: 1;
    cursor: pointer;
    color: var(--tone-fg, var(--text-muted));
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 3px 5px;
  }
  .icon-button:hover:not(:disabled) {
    color: var(--tone-fg-hover, var(--text));
  }
  /* One disabled treatment. There were three (0.4 / 0.45 / 0.5). */
  .icon-button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .icon-button:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: -1px;
  }

  .bare:hover:not(:disabled) {
    background: var(--surface-hover);
  }

  .outlined {
    border-color: var(--border);
  }
  .outlined:hover:not(:disabled) {
    border-color: var(--border-strong);
  }

  .filled {
    background: var(--surface-overlay);
  }
  .filled:hover:not(:disabled) {
    background: var(--surface-selected);
  }

  /* Sits inside a host-provided well; the well owns the inset look. */
  .segmented {
    border-radius: 3px;
    padding: 2px 5px;
  }
  .segmented.active {
    background: var(--surface-selected);
  }

  .bare.active,
  .outlined.active,
  .filled.active {
    color: var(--tone-fg-hover, var(--text));
    background: var(--surface-selected);
  }

  /* Tone sets two variables the rules above read, so every variant picks
     up a tone without a variant x tone matrix of selectors. */
  .tone-default {
    --tone-fg: var(--text-muted);
    --tone-fg-hover: var(--text);
  }
  .tone-accent {
    --tone-fg: var(--accent-text);
    --tone-fg-hover: var(--accent);
  }
  .tone-danger {
    --tone-fg: var(--danger-text);
    --tone-fg-hover: var(--danger);
  }
  .tone-success {
    --tone-fg: var(--success-text);
    --tone-fg-hover: var(--success);
  }
  .tone-warning {
    --tone-fg: var(--warning-text);
    --tone-fg-hover: var(--warning);
  }

  .text {
    white-space: nowrap;
  }
</style>
