<script lang="ts">
  // The Workstations hub. A thin template over hub/workstations.ts,
  // hub/inbox.ts, hub/inboxView.ts, unlock/unlock.ts and the visit's
  // state; the header is the bundle's own, so the hub and a Workstation's
  // UI read as one app.
  //
  // In this order, so the hub's own jobs never sit under the inbox: the
  // Unlock (held at the top while it is asked for), the hub's lines, the
  // Workstations and Pair, then what is waiting -- a count, its totals
  // per kind and the first few, with the whole list a screen of its own
  // (InboxList) -- then a debug build's keys panel.
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";
  import type { InboxRow } from "$shell/hub/inbox";
  import { inboxPreview, totalsLine } from "$shell/hub/inboxView";
  import type { HubWorkstation } from "$shell/hub/workstations";
  import InboxItem from "$shell/surfaces/InboxItem.svelte";
  import InboxList from "$shell/surfaces/InboxList.svelte";
  import type { Snippet } from "svelte";
  import type { VisitState } from "$shell/visit/visit";

  interface Props {
    workstations: HubWorkstation[];
    visit: VisitState;
    /// Whether this is the phone app. In a browser there is no webview to
    /// open a Workstation's UI in, and the hub says so rather than fail.
    native: boolean;
    onOpen: (workstation: HubWorkstation) => void;
    /// A Workstation that offers `Try now` was tapped.
    onTryNow?: (workstation: HubWorkstation) => void;
    onDismiss: () => void;
    /// "Pair a Workstation". Absent in a browser, which has no keys and no
    /// camera to pair with.
    onPair?: (() => void) | null;
    /// What is waiting on the human, on every ready Workstation. Null
    /// while there is nothing unlocked to ask.
    inbox?: InboxRow[] | null;
    onOpenItem?: (row: InboxRow) => void;
    /// Whether the whole inbox is on screen, and the ask to show or
    /// leave it.
    listing?: boolean;
    onList?: (open: boolean) => void;
    /// The Unlock's line, and whether it offers to unlock.
    unlockNotice?: { text: string; action: boolean } | null;
    onUnlock?: () => void;
    /// A line from the hub itself, dismissable.
    notice?: string | null;
    onDismissNotice?: () => void;
    /// At the foot: a debug build's keys panel.
    children?: Snippet;
  }
  let {
    workstations,
    visit,
    native,
    onOpen,
    onTryNow = () => {},
    onDismiss,
    onPair = null,
    inbox = null,
    onOpenItem = () => {},
    listing = false,
    onList = () => {},
    unlockNotice = null,
    onUnlock = () => {},
    notice = null,
    onDismissNotice = () => {},
    children,
  }: Props = $props();

  const opening = $derived(visit.status === "opening" ? visit.workstation : null);
  /// What the visit is doing meanwhile: fetching the Workstation's UI.
  const openingDetail = $derived(visit.status === "opening" ? visit.detail : null);
  const preview = $derived(inboxPreview(inbox ?? []));
</script>

<!-- The hub's own lines, over the hub and over the full list alike: a
     tap in either can start them. -->
{#snippet notices(inList: boolean)}
  {#if notice}
    <div class="note" role="status">
      <p>{notice}</p>
      <button type="button" class="action" onclick={onDismissNotice}>Dismiss</button>
    </div>
  {/if}
  {#if visit.status === "failed"}
    <div class="note" role="alert">
      <p class="problem">{visit.workstation.name} could not be opened: {visit.reason}.</p>
      <button type="button" class="action" onclick={onDismiss}>Dismiss</button>
    </div>
  {:else if inList && opening}
    <p class="note opening" role="status">Opening {opening.name}…{openingDetail ? ` ${openingDetail}` : ""}</p>
  {/if}
{/snippet}

{#snippet listNotices()}
  {@render notices(true)}
{/snippet}

<main class="hub">
  {#if listing && inbox && inbox.length > 0}
    <InboxList rows={inbox} {onOpenItem} onBack={() => onList(false)} notices={listNotices} />
  {:else}
    <PhoneHeader title="Workstations" />
    <div class="scroll">
      {#if unlockNotice}
        <!-- Held at the top: until it is answered nothing below connects. -->
        <div class="unlock" role="status">
          <p>{unlockNotice.text}</p>
          {#if unlockNotice.action}
            <button type="button" class="action primary" onclick={onUnlock}>Unlock</button>
          {/if}
        </div>
      {/if}

      {@render notices(false)}

      <section class="section" aria-label="Workstations">
        <ul class="cards">
          {#each workstations as ws (ws.id)}
            <li>
              <button
                type="button"
                class="card state-{ws.state}"
                disabled={opening !== null || !(ws.openable || ws.tryNow)}
                onclick={() => (ws.openable ? onOpen(ws) : onTryNow(ws))}
              >
                <span class="head">
                  <span class="name">{ws.name}</span>
                  {#if ws.demo}
                    <span class="tag">demo</span>
                  {/if}
                  {#if ws.waiting}
                    <span class="waiting">{ws.waiting} waiting</span>
                  {/if}
                  <span class="state">
                    <span class="dot" aria-hidden="true"></span>
                    {opening?.id === ws.id ? "Opening…" : ws.label}
                  </span>
                </span>
                {#if opening?.id === ws.id && openingDetail}
                  <span class="summary">{openingDetail}</span>
                {:else if ws.summary}
                  <span class="summary">{ws.summary}</span>
                {/if}
                {#if ws.tryNow}
                  <span class="try">Try now</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
        {#if onPair}
          <button type="button" class="action wide" disabled={opening !== null} onclick={onPair}>Pair a Workstation</button>
        {/if}
      </section>

      {#if inbox}
        <section class="section" aria-labelledby="hub-waiting">
          {#if inbox.length === 0}
            <h2 class="total" id="hub-waiting">Nothing is waiting on you.</h2>
          {:else}
            <h2 class="total" id="hub-waiting">{inbox.length} waiting on you</h2>
            <p class="totals">{totalsLine(inbox)}</p>
            <ul class="cards">
              {#each preview.shown as row (row.key)}
                <li><InboxItem {row} where={row.workstationName} onOpen={onOpenItem} /></li>
              {/each}
            </ul>
            {#if preview.more > 0}
              <button type="button" class="action wide" onclick={() => onList(true)}>Show all {inbox.length}</button>
            {/if}
          {/if}
        </section>
      {/if}

      {#if !native}
        <p class="aside">
          This is the hub as a browser draws it. A Workstation’s UI opens only in the Companion app, in a
          view of its own.
        </p>
      {/if}

      {@render children?.()}
    </div>
  {/if}
</main>

<style>
  .hub {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
    /* Clear of the side insets, the Dynamic Island's band and the
       rounded corners of a phone on its side, once for the whole hub, as
       the bundle's page is (companion/src/routes/+page.svelte): nothing
       inside reads a side inset of its own. */
    padding: 0 env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
    box-sizing: border-box;
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom));
    overflow-y: auto;
  }
  /* Every block of the hub: the same gutter, the same space above. */
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: var(--space-3) var(--space-2) 0;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-half);
    box-sizing: border-box;
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-raised);
    color: var(--text);
    text-align: left;
  }
  .card:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .card:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .card:disabled {
    color: var(--text);
  }
  /* Wraps: at a large text size the tag, the count and the state go
     under the name rather than squeezing it to its first letters. */
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-half) var(--space-1);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    font-size: 1.0625rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The same tag the bundle's header puts beside a demo's name. */
  .tag {
    flex: 0 0 auto;
    padding: 2px 6px;
    border: 1px solid var(--border-warning);
    border-radius: 4px;
    background: var(--surface-warning);
    color: var(--warning-text);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .waiting {
    flex: 0 0 auto;
    padding: 0 var(--space-1);
    border: 1px solid var(--border-accent);
    border-radius: 10px;
    line-height: 1.6;
    background: var(--surface-accent);
    color: var(--accent-text);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .state {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--space-half);
    margin-left: auto;
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-subtle);
  }
  .state-ready .dot {
    background: var(--success-text);
  }
  .state-connecting .dot {
    background: var(--accent);
  }
  .state-desktop-app-not-running .dot,
  .state-unreachable .dot,
  .state-asleep .dot {
    background: var(--warning-text);
  }
  .state-refused .dot,
  .state-failed .dot {
    background: var(--danger-text);
  }
  .summary {
    color: var(--text-muted);
    font-size: 0.8125rem;
    line-height: 1.4;
  }
  /* The whole card is the button; this says what tapping it does. */
  .try {
    align-self: flex-start;
    margin-top: var(--space-half);
    padding: var(--space-half) var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-base);
    font-size: 0.8125rem;
  }
  .total {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
  }
  .totals {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.8125rem;
    line-height: 1.4;
  }
  /* Held at the top of the hub while it is shown: it is what lets the
     rest connect. */
  .unlock {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
  }
  .unlock p {
    flex: 1 1 auto;
    margin: 0;
    color: var(--text);
    font-size: 0.875rem;
    line-height: 1.4;
  }
  .note {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .note p {
    flex: 1 1 auto;
    margin: 0;
  }
  .opening {
    min-height: 44px;
  }
  .aside {
    margin: 0;
    padding: var(--space-3) var(--space-2) 0;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .problem {
    color: var(--danger-text);
  }
  .action {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .wide {
    width: 100%;
  }
  .primary {
    border-color: var(--border-accent);
    background: var(--surface-accent);
    color: var(--accent-text);
    font-weight: 600;
  }
  .action:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .action:disabled {
    opacity: 0.5;
  }
  .action:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
</style>
