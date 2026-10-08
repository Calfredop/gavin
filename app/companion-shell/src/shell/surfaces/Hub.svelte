<script lang="ts">
  // The Workstations hub. A thin template over hub/workstations.ts,
  // hub/inbox.ts, unlock/unlock.ts and the visit's state; the header is
  // the bundle's own, so the hub and a Workstation's UI read as one app.
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";
  import { kindLabel, type InboxRow } from "$shell/hub/inbox";
  import type { HubWorkstation } from "$shell/hub/workstations";
  import type { Snippet } from "svelte";
  import type { VisitState } from "$shell/visit/visit";

  interface Props {
    workstations: HubWorkstation[];
    visit: VisitState;
    /// Whether this is the phone app. In a browser there is no webview to
    /// open a Workstation's UI in, and the hub says so rather than fail.
    native: boolean;
    onOpen: (workstation: HubWorkstation) => void;
    onDismiss: () => void;
    /// "Pair a Workstation". Absent in a browser, which has no keys and no
    /// camera to pair with.
    onPair?: (() => void) | null;
    /// What is waiting on the human, on every ready Workstation. Null
    /// while there is nothing unlocked to ask.
    inbox?: InboxRow[] | null;
    onOpenItem?: (row: InboxRow) => void;
    /// The Unlock's line, and whether it offers to unlock.
    unlockNotice?: { text: string; action: boolean } | null;
    onUnlock?: () => void;
    /// A line from the hub itself, dismissable.
    notice?: string | null;
    onDismissNotice?: () => void;
    /// Below the Workstations: a debug build's keys panel.
    children?: Snippet;
  }
  let {
    workstations,
    visit,
    native,
    onOpen,
    onDismiss,
    onPair = null,
    inbox = null,
    onOpenItem = () => {},
    unlockNotice = null,
    onUnlock = () => {},
    notice = null,
    onDismissNotice = () => {},
    children,
  }: Props = $props();

  const opening = $derived(visit.status === "opening" ? visit.workstation.id : null);
  /// What the visit is doing meanwhile: fetching the Workstation's UI.
  const openingDetail = $derived(visit.status === "opening" ? visit.detail : null);
</script>

<main class="hub">
  <PhoneHeader title="Workstations" />
  <div class="scroll">
    {#if unlockNotice}
      <div class="unlock" role="status">
        <p>{unlockNotice.text}</p>
        {#if unlockNotice.action}
          <button type="button" class="action" onclick={onUnlock}>Unlock</button>
        {/if}
      </div>
    {/if}

    {#if notice}
      <div class="note" role="status">
        <p>{notice}</p>
        <button type="button" class="action" onclick={onDismissNotice}>Dismiss</button>
      </div>
    {/if}

    {#if inbox}
      <h2 class="section">Waiting on you</h2>
      {#if inbox.length === 0}
        <p class="empty">Nothing is waiting on you.</p>
      {:else}
        <ul class="list">
          {#each inbox as row (row.key)}
            <li>
              <button type="button" class="row item kind-{row.kind}" onclick={() => onOpenItem(row)}>
                <span class="head">
                  <span class="kind">{kindLabel(row.kind)}</span>
                  <span class="where">{row.workstationName}</span>
                </span>
                <span class="text">{row.text}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <h2 class="section">Workstations</h2>
    {/if}

    <ul class="list">
      {#each workstations as ws (ws.id)}
        <li>
          <button type="button" class="row" disabled={opening !== null || !ws.openable} onclick={() => onOpen(ws)}>
            <span class="head">
              <span class="name">{ws.name}</span>
              {#if ws.demo}
                <span class="tag">demo</span>
              {/if}
              <span class="state state-{ws.state}">
                <span class="dot" aria-hidden="true"></span>
                {opening === ws.id ? "Opening…" : ws.label}
              </span>
            </span>
            {#if opening === ws.id && openingDetail}
              <span class="summary">{openingDetail}</span>
            {:else if ws.summary}
              <span class="summary">{ws.summary}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>

    {#if onPair}
      <div class="pair">
        <button type="button" class="action" disabled={opening !== null} onclick={onPair}>Pair a Workstation</button>
      </div>
    {/if}

    {#if visit.status === "failed"}
      <div class="note" role="alert">
        <p class="problem">{visit.workstation.name} could not be opened: {visit.reason}.</p>
        <button type="button" class="action" onclick={onDismiss}>Dismiss</button>
      </div>
    {:else if !native}
      <p class="note">
        This is the hub as a browser draws it. A Workstation’s UI opens only in the Companion app, in a
        view of its own.
      </p>
    {/if}

    {@render children?.()}
  </div>
</main>

<style>
  .hub {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: env(safe-area-inset-bottom);
    overflow-y: auto;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding: 14px max(14px, env(safe-area-inset-right)) 14px max(14px, env(safe-area-inset-left));
    border: 0;
    border-bottom: 1px solid var(--border);
    background: none;
    color: var(--text);
    text-align: left;
  }
  .row:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .row:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .row:disabled {
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
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
  .state {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
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
  .state-unreachable .dot {
    background: var(--warning-text);
  }
  .state-refused .dot,
  .state-failed .dot {
    background: var(--danger-text);
  }
  .section {
    margin: 0;
    padding: 18px max(14px, env(safe-area-inset-right)) 6px max(14px, env(safe-area-inset-left));
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .empty {
    margin: 0;
    padding: 4px 14px 12px;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .kind {
    flex: 0 0 auto;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .kind-failed .kind,
  .kind-interrupted .kind {
    color: var(--danger-text);
  }
  .kind-waiting .kind,
  .kind-human-test .kind {
    color: var(--accent);
  }
  .kind-rail-stopped .kind {
    color: var(--warning-text);
  }
  .where {
    min-width: 0;
    margin-left: auto;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 0.8125rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .text {
    font-size: 0.9375rem;
    line-height: 1.4;
  }
  .unlock {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px max(14px, env(safe-area-inset-right)) 12px max(14px, env(safe-area-inset-left));
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
  .summary {
    color: var(--text-muted);
    font-size: 0.8125rem;
    line-height: 1.4;
  }
  .pair {
    padding: 16px max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left));
  }
  .note {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .note p {
    margin: 0 0 12px;
  }
  .problem {
    color: var(--danger-text);
  }
  .action {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
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
