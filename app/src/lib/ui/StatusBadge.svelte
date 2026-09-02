<script lang="ts">
  // The one badge. Every small state indicator in the app draws through
  // it, from an `Indicator` produced by indicators.ts -- which is what
  // makes "the same fact looks the same everywhere" a property of the
  // code rather than a habit reviewers have to police.
  //
  // It deliberately owns almost no policy: the glyph, the tone and the
  // tooltip all arrive decided. What lives here is only how a badge sits
  // in a row (inline, baseline-safe, never shrinking) and how a tone maps
  // onto the theme's tokens -- the same two variables IconButton uses, so
  // an amber badge and an amber button beside it are the same amber.
  import type { Indicator } from "./indicators";
  import { tooltip } from "../tooltip";

  interface Props {
    indicator: Indicator;
    size?: number;
    /// A count or short word rendered after the glyph, in the badge's own
    /// tone -- "3" on a tally, "working" beside a card's session row.
    text?: string | number | null;
    /// Replaces the indicator's own tooltip where the surface can say
    /// something more specific ("Waiting for input — click to open the
    /// session"). Null opts out entirely, for the rare host that already
    /// wraps the badge in its own bubble.
    tip?: string | null;
    /// Positioning only, never appearance: margins, `margin-left: auto`,
    /// reveal-on-hover. What the badge LOOKS like is the tone's business.
    class?: string;
  }

  let { indicator, size = 11, text = null, tip, class: extraClass = "" }: Props = $props();

  const Icon = $derived(indicator.icon);
  const tipText = $derived(tip === undefined ? indicator.tip : tip);
  // The glyph is not decorative -- it is the whole message -- so the
  // badge is an image with a name. When there is visible text too, the
  // label covers both and the text is not announced twice.
  const ariaLabel = $derived(text === null ? indicator.label : `${indicator.label}: ${text}`);
</script>

<span
  class="status-badge tone-{indicator.tone} axis-{indicator.axis} state-{indicator.state} {extraClass}"
  class:spin={indicator.spin}
  role="img"
  aria-label={ariaLabel}
  use:tooltip={tipText}
>
  <Icon {size} />
  {#if text !== null}<span class="badge-text">{text}</span>{/if}
</span>

<style>
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    line-height: 1;
    color: var(--badge-fg, var(--text-muted));
  }
  .badge-text {
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }

  /* Tone sets one variable the rule above reads, exactly as IconButton
     does, so tones stay addable without a tone x context matrix. */
  .tone-neutral {
    --badge-fg: var(--text-muted);
  }
  .tone-accent {
    --badge-fg: var(--accent-text);
  }
  .tone-success {
    --badge-fg: var(--success-text);
  }
  .tone-warning {
    --badge-fg: var(--warning-text);
  }
  .tone-danger {
    --badge-fg: var(--danger-text);
  }

  /* Motion is a claim: only a state that means "happening right now"
     spins, and only ever at the app's one spinner tempo (0.8s, shared
     with the commit spinner and the hub tab's). The glyph rotates rather
     than the box, so a badge with text beside it does not orbit. */
  .spin :global(svg) {
    animation: badge-spin 0.8s linear infinite;
  }
  @keyframes badge-spin {
    to {
      transform: rotate(360deg);
    }
  }
  /* A reader who has asked the OS for less motion still needs to know
     which session is running -- the tone and the glyph already say so,
     so only the animation is dropped. */
  @media (prefers-reduced-motion: reduce) {
    .spin :global(svg) {
      animation: none;
    }
  }
</style>
