<script lang="ts">
  import { pushModal, popModal, isTopModal } from "./modalStack";

  interface Props {
    onClose: () => void;
    // Identity of what the panel is showing. A modal that can be
    // repointed at something else without unmounting (the card detail
    // navigating to a nested task) keeps the old scroll offset
    // otherwise, which on shorter content lands the reader at the
    // bottom of a card they have not seen the top of.
    scrollKey?: string;
    // Lifts the panel's width cap for content that is a TABLE rather
    // than a column of label/control rows. Opt-in rather than a width
    // the child sets on its own contents: the cap lives on .panel, which
    // is scoped here, so a child wider than 480px otherwise just
    // overflows the panel it is inside.
    wide?: boolean;
    // Hands scrolling to the child. The panel then clips instead of
    // scrolling and lays its content out as a column, so a child that
    // keeps a header and a footer in place can scroll only the part
    // between them. Opt-in for the same reason as `wide`: position:
    // sticky inside the panel's own scroller would stick to its padding
    // edge, with the padding sliding past underneath.
    innerScroll?: boolean;
    // Draws the panel as a PANE rather than as a dialog: it fills its
    // container instead of floating over a backdrop, drops the width and
    // height caps, and takes no part in the modal stack. Escape and a
    // click outside stop closing it, which is the point -- a pane the
    // human split off deliberately must not vanish because they pressed
    // Escape in the terminal beside it.
    inline?: boolean;
    children?: import("svelte").Snippet;
  }
  let {
    onClose,
    scrollKey,
    wide = false,
    innerScroll = false,
    inline = false,
    children,
  }: Props = $props();

  let panel = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (scrollKey === undefined) return;
    if (panel) panel.scrollTop = 0;
  });

  // Registered for as long as this modal is on screen, so an Escape
  // reaches only the topmost one -- see modalStack.ts for why the
  // window-level listener needs it.
  let token = $state<symbol | null>(null);
  $effect(() => {
    if (inline) return;
    const mine = pushModal();
    token = mine;
    return () => popModal(mine);
  });

  function handleBackdropClick(event: MouseEvent): void {
    if (inline) return;
    if (event.target === event.currentTarget) onClose();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (inline) return;
    if (event.key !== "Escape") return;
    if (token && !isTopModal(token)) return;
    onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="backdrop" class:inline onclick={handleBackdropClick} role="presentation">
  <div
    class="panel"
    class:wide
    class:inner-scroll={innerScroll}
    class:inline
    role={inline ? undefined : "dialog"}
    aria-modal={inline ? undefined : "true"}
    bind:this={panel}
  >
    {@render children?.()}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .panel {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    min-width: 320px;
    max-width: 480px;
    max-height: 80vh;
    overflow-y: auto;
    color: var(--text);
    font-family: monospace;
  }
  .panel.wide {
    max-width: min(880px, 92vw);
  }
  .panel.inner-scroll {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* Inline: absolute rather than fixed, so the panel fills the PANE it
     was mounted in rather than the window. The host is responsible for
     being a positioned box (every pane in Pane.svelte already is). */
  .backdrop.inline {
    position: absolute;
    background: none;
    z-index: auto;
    display: block;
  }
  .panel.inline {
    width: 100%;
    height: 100%;
    /* Tighter than a dialog's 20px: a pane is already framed by its own
       tab bar and the split beside it, so the panel's job is to use the
       width it was given rather than to stand apart from a backdrop. */
    padding: 12px;
    max-width: none;
    max-height: none;
    min-width: 0;
    border: none;
    border-radius: 0;
    background: var(--surface-base);
    box-sizing: border-box;
  }
</style>
