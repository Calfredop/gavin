<script lang="ts">
  // The formatting bar over a markdown file in Edit mode. A thin
  // template: which buttons exist, what they say and which chord they
  // carry all come from markdownFormatting.ts, so the only thing decided
  // here is the icon each one wears.
  import type { Component } from "svelte";
  import {
    Bold,
    Code,
    Heading1,
    Heading2,
    Heading3,
    Italic,
    Link,
    List,
    ListOrdered,
    ListTodo,
    Minus,
    SquareCode,
    Strikethrough,
    Table,
    TextQuote,
  } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { FORMAT_GROUPS, type FormatAction, type FormatButton } from "$lib/files/markdownFormatting";
  import { formatChord } from "$lib/core/shortcuts";
  import { isMacSync } from "$lib/core/platform";

  interface Props {
    onFormat: (action: FormatAction) => void;
  }
  let { onFormat }: Props = $props();

  const ICONS: Record<FormatAction, Component<{ size?: number }>> = {
    bold: Bold,
    italic: Italic,
    strikethrough: Strikethrough,
    code: Code,
    link: Link,
    "heading-1": Heading1,
    "heading-2": Heading2,
    "heading-3": Heading3,
    "bullet-list": List,
    "numbered-list": ListOrdered,
    "task-list": ListTodo,
    quote: TextQuote,
    "code-block": SquareCode,
    rule: Minus,
    table: Table,
  };

  const isMac = isMacSync();

  function tipFor(button: FormatButton): string {
    return button.chord ? `${button.label} (${formatChord(button.chord, isMac)})` : button.label;
  }

  // A click must not move focus off the editor: the selection the
  // action reads is the editor's, and it collapses the moment the
  // button takes focus.
  function keepEditorFocus(event: MouseEvent): void {
    event.preventDefault();
  }
</script>

<div class="format-bar" role="toolbar" aria-label="Formatting">
  {#each FORMAT_GROUPS as group, i (i)}
    {#if i > 0}<span class="sep" aria-hidden="true"></span>{/if}
    {#each group as button (button.action)}
      <IconButton
        icon={ICONS[button.action]}
        label={button.label}
        tip={tipFor(button)}
        size={13}
        tabindex={-1}
        onmousedown={keepEditorFocus}
        onclick={() => onFormat(button.action)}
      />
    {/each}
  {/each}
</div>

<style>
  .format-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 1px;
    min-width: 0;
  }
  .sep {
    width: 1px;
    height: 14px;
    margin: 0 4px;
    background: var(--border);
  }
</style>
