<script lang="ts">
  import { onMount } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import Modal from "$lib/core/Modal.svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import * as backend from "$lib/core/backend";
  import { tooltip } from "$lib/core/tooltip";
  import { askConfirm } from "$lib/core/dialog";
  import { daemonCompat } from "$lib/core/layoutState";
  import { grantForAnsweredPrompt, pairingSubject } from "$lib/core/confirmGate";
  import {
    NO_DEVICES,
    PAIRING_IDLE,
    countdownLabel,
    knownDevice,
    pairingClosed,
    pairingConfirmCopy,
    pairingConfirmed,
    pairingOffered,
    pairingOpen,
    pairingRejected,
    pairingRequested,
    pairingTick,
    pairingUnavailable,
    qrDraw,
    relayStatus,
    revokeAllCopy,
    revokeDeviceCopy,
    type PairingRequest,
    type PairingState,
  } from "$lib/core/remoteAccess";
  import { DEVICES_LABEL, devicesBlocked, panelRows } from "$lib/core/devicesPanel";
  import {
    connectedDevices,
    deviceList,
    deviceRelayState,
    devicesFailure,
    refreshDeviceList,
    refreshDeviceRelay,
  } from "$lib/core/devicesState";
  import { relayIndicator } from "$lib/ui/indicators";

  let { onClose }: { onClose: () => void } = $props();

  // Every control reads `gate`: against a daemon older than the version
  // remote access needs, the panel says which version rather than sending a
  // request that ends in a wire error. The reason hangs on a WRAPPING span,
  // never on the disabled control -- a disabled element fires no
  // mouseenter, so a tooltip on it never opens.
  const gate = $derived(devicesBlocked($daemonCompat));

  let pairing = $state<PairingState>(PAIRING_IDLE);
  let pairingError = $state<string | null>(null);
  let busy = $state(false);
  let actionError = $state<string | null>(null);
  let nowMs = $state(Date.now());

  const rows = $derived($deviceList ? panelRows($deviceList.devices, $connectedDevices, nowMs) : []);
  const pairingGate = $derived(pairingUnavailable($deviceList, $daemonCompat, $deviceRelayState));
  const relayLine = $derived(relayStatus($deviceRelayState, nowMs));
  const relayBadge = $derived(
    relayLine.badge === null
      ? null
      : relayIndicator(
          relayLine.badge,
          $deviceRelayState?.state === "failed" ? `${$deviceRelayState.why}` : null
        )
  );

  onMount(() => {
    void refreshDeviceList();
    void refreshDeviceRelay();
    // The pairing question is heard only while this panel is open: the
    // daemon refuses a pairing outright when no `app` connection is live,
    // and a question nobody is being asked is not a notification -- it is a
    // dialog waiting to fire over some other screen.
    const stop: Promise<UnlistenFn> = listen<[string, string, string]>(
      "device-pairing-requested",
      (event) => {
        const [deviceId, name, sas] = event.payload;
        const next = pairingRequested(pairing, { deviceId, name, sas });
        if (next === pairing) return; // a second phone, or no offer on screen
        pairing = next;
        void askPairing({ deviceId, name, sas });
      }
    );
    return () => void stop.then((off) => off());
  });

  // A clock while the panel is open, so the countdown and the ages come
  // off a tick rather than off whenever the panel last re-rendered.
  $effect(() => {
    const timer = setInterval(() => {
      nowMs = Date.now();
      if (pairingOpen(pairing)) pairing = pairingTick(pairing, nowMs);
    }, 1000);
    return () => clearInterval(timer);
  });

  async function startPairing(): Promise<void> {
    pairingError = null;
    try {
      pairing = pairingOffered(await backend.beginPairing());
      nowMs = Date.now();
    } catch (e) {
      pairing = PAIRING_IDLE;
      pairingError = String(e instanceof Error ? e.message : e);
    }
  }

  /// The six-digit comparison: two named answers and no third, so a
  /// prompt that keeps focus on Reject and cannot be confirmed by Enter.
  async function askPairing(request: PairingRequest): Promise<void> {
    const said = await askConfirm(pairingConfirmCopy(request, knownDevice(request, $deviceList)));
    pairingError = null;
    try {
      if (said) {
        const token = await grantForAnsweredPrompt("confirm_pairing", [
          pairingSubject(request.deviceId, request.sas),
        ]);
        await backend.confirmPairing(request.deviceId, request.sas, token);
        pairing = pairingConfirmed(pairing);
      } else {
        await backend.rejectPairing(request.deviceId);
        pairing = pairingRejected(pairing);
      }
    } catch (e) {
      pairingError = String(e instanceof Error ? e.message : e);
    }
    await refreshDeviceList();
  }

  async function revokeOne(row: { deviceId: string; name: string }): Promise<void> {
    if (!(await askConfirm(revokeDeviceCopy(row)))) return;
    busy = true;
    actionError = null;
    try {
      await backend.revokeDevice(row.deviceId);
    } catch (e) {
      actionError = String(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
    await refreshDeviceList();
  }

  async function revokeAll(): Promise<void> {
    if (!(await askConfirm(revokeAllCopy()))) return;
    busy = true;
    actionError = null;
    try {
      await backend.revokeAllDevices();
      // The offer on screen was minted under the OLD key.
      pairing = pairingClosed();
    } catch (e) {
      actionError = String(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
    await refreshDeviceList();
  }
</script>

<Modal {onClose}>
  <div class="devices-panel">
    <h2>{DEVICES_LABEL}</h2>
    <p class="hint">
      Pair a phone here, at the desk, and manage what it may reach. The remote access switch, the
      Relay and the admission token are in Settings.
    </p>
    {#if gate}
      <p class="hint warn">{gate}</p>
    {/if}
    {#if relayBadge}
      <p class="hint relay-status">
        <StatusBadge indicator={relayBadge} text={relayLine.text} />
        {#if relayLine.detail}<span class="detail">{relayLine.detail}</span>{/if}
      </p>
    {/if}

    <div class="actions">
      <span use:tooltip={gate ?? pairingGate ?? ""}>
        <button
          type="button"
          class="manage"
          disabled={gate !== null || pairingGate !== null}
          onclick={() => void startPairing()}
        >
          Pair a device
        </button>
      </span>
      <span use:tooltip={gate ?? ""}>
        <button
          type="button"
          class="manage danger"
          disabled={gate !== null || busy || rows.length === 0}
          onclick={() => void revokeAll()}
        >
          Revoke all devices
        </button>
      </span>
    </div>
    {#if pairingError}
      <p class="hint warn">Pairing failed: {pairingError}</p>
    {/if}

    {#if pairingOpen(pairing)}
      <div class="pairing">
        {#if pairing.phase === "offer" || pairing.phase === "requested"}
          {@const drawn = qrDraw(pairing.qr)}
          {#if drawn.error}
            <p class="hint warn">Couldn't draw the QR: {drawn.error}</p>
          {:else}
            <!-- Inline SVG drawn from the payload by qr.ts: no image
                 service, no CDN, no dependency -- what is being drawn is a
                 pairing secret. -->
            <svg
              class="qr"
              viewBox="0 0 {drawn.size} {drawn.size}"
              role="img"
              aria-label="Pairing QR code"
            >
              <rect width={drawn.size} height={drawn.size} fill="#fff" />
              <path d={drawn.path} fill="#000" />
            </svg>
          {/if}
          <div class="pairing-text">
            {#if pairing.phase === "requested"}
              <p>Waiting for your answer on the prompt.</p>
            {:else}
              <p>Scan this with the phone you want to pair.</p>
            {/if}
            <p class="hint">
              This code expires in {countdownLabel(pairing.expiresAt, nowMs)}. It is one use only,
              and scanning it is not enough on its own — you confirm a six-digit code here, on the
              desktop, before the device exists.
            </p>
          </div>
        {:else if pairing.phase === "confirmed"}
          <p>“{pairing.request.name}” is paired.</p>
        {:else if pairing.phase === "rejected"}
          <p>“{pairing.request.name}” was rejected. Nothing was written.</p>
        {:else}
          <p>That pairing code expired. Press Pair a device for a new one.</p>
        {/if}
        <button type="button" class="manage" onclick={() => (pairing = pairingClosed())}>
          Close
        </button>
      </div>
    {/if}

    {#if actionError ?? $devicesFailure}
      <p class="hint warn">{actionError ?? $devicesFailure}</p>
    {/if}
    <!-- Nothing about the list against a daemon that was never asked:
         "no devices are paired" would be an assertion about a store this
         build could not read. -->
    {#if gate === null && $deviceList}
      {#if rows.length === 0}
        <p class="hint">{NO_DEVICES}</p>
      {:else}
        <ul class="devices">
          {#each rows as row (row.deviceId)}
            <li class:dimmed={row.dimmed}>
              <span class="device-name">{row.name}</span>
              <span class="device-role">{row.role}</span>
              <span
                class="device-state"
                class:connected={row.connected}
                title={row.lastSeenTitle}>{row.state}</span
              >
              {#if row.note}<span class="warn">{row.note}</span>{/if}
              <span use:tooltip={gate ?? ""}>
                <button
                  type="button"
                  class="manage danger"
                  disabled={gate !== null || busy || !row.revocable}
                  onclick={() => void revokeOne(row)}
                >
                  Revoke
                </button>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</Modal>

<style>
  .devices-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--text);
  }
  .hint {
    color: var(--text-subtle);
    margin: 0;
  }
  .hint.warn,
  .warn {
    color: var(--warning-text);
  }
  .detail {
    opacity: 0.75;
    font-size: 0.9em;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
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
  button.manage:disabled {
    opacity: 0.55;
    cursor: default;
  }
  button.manage.danger {
    color: var(--danger-text);
  }
  .pairing {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin: 6px 0;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  /* A fixed box rather than one sized by the symbol, so the panel does not
     jump when the Relay URL changes length. White ground in both themes: a
     dark-on-dark QR is one no camera reads. */
  .pairing svg.qr {
    flex: 0 0 auto;
    width: 168px;
    height: 168px;
    border-radius: 4px;
  }
  .pairing-text {
    min-width: 0;
  }
  .pairing p {
    margin: 0 0 6px;
  }
  .devices {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .devices li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    border-top: 1px solid var(--border);
  }
  /* Greyed, not hidden: a revoked row is the record that the revocation
     happened, and a stale one has to be visible to be re-paired. */
  .devices li.dimmed .device-name,
  .devices li.dimmed .device-role,
  .devices li.dimmed .device-state {
    opacity: 0.5;
  }
  .device-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .device-role,
  .device-state {
    flex: 0 0 auto;
    color: var(--text-subtle);
  }
  .device-state.connected {
    color: var(--success-text, var(--text));
  }
</style>
