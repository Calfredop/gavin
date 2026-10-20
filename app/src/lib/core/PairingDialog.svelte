<script lang="ts">
  import Modal from "$lib/core/Modal.svelte";
  import { countdownLabel, pairingSheet, qrDraw, type PairingState } from "$lib/core/remoteAccess";

  // Its own dialog over the Devices panel, not a box inside it: the sheet
  // under the code names every way in and what each needs, and in the
  // panel's 480px column that text wrapped into a ribbon beside the QR.
  // The Devices panel keeps the state; this only draws it.
  let { pairing, nowMs, onClose }: { pairing: PairingState; nowMs: number; onClose: () => void } = $props();
</script>

<Modal {onClose} wide>
  <div class="pairing-dialog">
    <h2>Pair a device</h2>
    {#if pairing.phase === "offer" || pairing.phase === "requested"}
      {@const drawn = qrDraw(pairing.qr)}
      {@const sheet = pairingSheet(pairing.qr)}
      <div class="body">
        {#if drawn.error}
          <p class="hint warn">Couldn't draw the QR: {drawn.error}</p>
        {:else}
          <!-- Inline SVG drawn from the payload by qr.ts: no image
               service, no CDN, no dependency -- what is being drawn is a
               pairing secret. -->
          <svg class="qr" viewBox="0 0 {drawn.size} {drawn.size}" role="img" aria-label="Pairing QR code">
            <rect width={drawn.size} height={drawn.size} fill="#fff" />
            <path d={drawn.path} fill="#000" />
          </svg>
        {/if}
        <div class="text">
          {#if pairing.phase === "requested"}
            <p>Waiting for your answer on the prompt.</p>
          {:else}
            <p>Scan this with the phone you want to pair.</p>
          {/if}
          <p class="hint">
            This code expires in {countdownLabel(pairing.expiresAt, nowMs)}. It is one use only, and
            scanning it is not enough on its own — you confirm a six-digit code here, on the desktop,
            before the device exists.
          </p>
          {#if sheet.paths.length > 0}
            <p>It carries these ways in:</p>
            <ul class="paths">
              {#each sheet.paths as path (path.url)}
                <li><span class="path-kind">{path.label}</span> <code>{path.url}</code></li>
              {/each}
            </ul>
            {#each sheet.notes as note (note)}
              <p class="hint">{note}</p>
            {/each}
          {/if}
        </div>
      </div>
    {:else if pairing.phase === "confirmed"}
      <p>“{pairing.request.name}” is paired.</p>
    {:else if pairing.phase === "rejected"}
      <p>“{pairing.request.name}” was rejected. Nothing was written.</p>
    {:else}
      <p>That pairing code expired. Press Pair a device for a new one.</p>
    {/if}
    <div class="footer">
      <button type="button" class="manage" onclick={onClose}>Close</button>
    </div>
  </div>
</Modal>

<style>
  .pairing-dialog {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    max-width: 720px;
  }
  h2 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--text);
  }
  p {
    margin: 0 0 8px;
  }
  .hint {
    color: var(--text-subtle);
  }
  .hint.warn {
    color: var(--warning-text);
  }
  /* Wraps rather than squeezing: in a narrow window the text goes under
     the code instead of into a column a few words wide. */
  .body {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 20px;
  }
  /* A fixed box rather than one sized by the symbol, so the dialog does
     not jump when the Relay URL changes length. White ground in both
     themes: a dark-on-dark QR is one no camera reads. */
  svg.qr {
    flex: 0 0 auto;
    width: 220px;
    height: 220px;
    border-radius: 4px;
  }
  .text {
    flex: 1 1 320px;
    min-width: 0;
  }
  .paths {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .paths li {
    overflow-wrap: anywhere;
  }
  .path-kind {
    display: inline-block;
    min-width: 7em;
    color: var(--text-subtle);
  }
  .footer {
    display: flex;
    justify-content: flex-end;
  }
  button.manage {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    padding: 3px 8px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
</style>
