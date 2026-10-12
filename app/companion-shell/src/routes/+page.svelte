<script lang="ts">
  // The shell's one page: the Workstations hub, the visits it opens,
  // pairing, the Unlock and notifications. Every decision is in a module
  // (visit.ts, shellChannel.ts, probe.ts, keysCheck.ts, pairFlow.ts,
  // paired.ts, unlock.ts, liveHub.ts, inbox.ts, push/setup.ts,
  // push/taps.ts); this wires them to the native views and draws the hub.
  import { onMount } from "svelte";
  import { Capacitor } from "@capacitor/core";
  import { assets } from "$app/paths";
  import { readyBundle } from "$shell/bundle/bundle";
  import { bundlesToKeep, nativeBundleStore, rememberBundle, type BundleMemory } from "$shell/bundle/store";
  import { trustedKeys } from "$shell/bundle/trust";
  import { combinedInbox, type InboxRow } from "$shell/hub/inbox";
  import { pairedStore, type PairedWorkstation } from "$shell/hub/paired";
  import { createUnlockedHub } from "$shell/hub/unlockedHub";
  import { hubWorkstations } from "$shell/hub/workstations";
  import { runKeysCheck } from "$shell/keys/keysCheck";
  import { BundleView } from "$shell/native/bundleView";
  import { DeviceKeys } from "$shell/native/deviceKeys";
  import { Push } from "$shell/native/push";
  import { QrScanner } from "$shell/native/qrScanner";
  import { Workstations } from "$shell/native/workstations";
  import { coreOnce, phonePairFlow } from "$shell/pairing/phonePairing";
  import { webSocketOpener, type WebSocketConstructor } from "$shell/pairing/relaySocket";
  import { PROBE_WORKSTATION, createProbeBench, runProbe, type ProbeBench } from "$shell/probe/probe";
  import { readNotifyLink } from "$shell/push/decrypt";
  import { notifyLine, setUpNotifications, type NotifySetup } from "$shell/push/setup";
  import { gatewayClient } from "$shell/push/gateway";
  import { createHandover, handOver, notifyWord } from "$shell/push/handover";
  import { clearsFor, pendingTap, stepTap, type PendingTap } from "$shell/push/taps";
  import Hub from "$shell/surfaces/Hub.svelte";
  import KeysPanel from "$shell/surfaces/KeysPanel.svelte";
  import PairingSheet from "$shell/surfaces/PairingSheet.svelte";
  import { endpointFor } from "$shell/visit/endpoints";
  import { createVisits } from "$shell/visit/visit";
  import { leavesVisitOnLock, returnFor, stepReturn, type PendingReturn } from "$shell/unlock/leaveOnLock";
  import { connectionsAllowed, unlockNotice, type UnlockState } from "$shell/unlock/unlock";

  const PROBE_TIMEOUT_MS = 30_000;

  /// Set only while a debug build runs the bundle probe.
  let probe: ProbeBench | null = null;
  /// The keys a served bundle may be signed by: the pinned publisher
  /// key, and in a debug build the dev key the native side embeds.
  let trusted: string[] = [];

  /// Where the page remembers which bundle each Workstation last served.
  function bundleMemory(): BundleMemory | null {
    try {
      return localStorage;
    } catch {
      return null;
    }
  }

  const visits = createVisits({
    view: BundleView,
    endpointFor: (ws) =>
      probe && ws.id === PROBE_WORKSTATION.id
        ? probe.visit
        : endpointFor(ws, unlocked ? (id) => unlocked.connectionSource(id) : null, undefined, (line) => {
            if (debugBuild) console.log(line);
          }),
    // The Demo's bundle (and the probe's, in a debug build) ships in the
    // binary; a paired Workstation's is served by it, over the live
    // hub's connection, and cached by hash.
    prepare: async (ws, say, signal) => {
      if (ws.demo) return "demo";
      if (probe && ws.id === PROBE_WORKSTATION.id) return "probe";
      const connection = unlocked?.connectionSource(ws.id).current();
      if (!connection) throw new Error("it is not connected. Unlock the Companion, and wait for it to be ready");
      const ready = await readyBundle({
        connection,
        store: nativeBundleStore(BundleView),
        core,
        trusted,
        say,
        signal,
      });
      if (debugBuild) console.log(`[gavin-shell] ${ws.id}: bundle ${ready.hash.slice(0, 12)}… ${ready.fetched ? "fetched" : "cached"}`);
      const memory = bundleMemory();
      rememberBundle(memory, ws.id, ready.hash);
      if (ready.fetched) {
        void BundleView.prune({ keep: bundlesToKeep(memory, paired.map((p) => p.id), ready.hash) }).catch(() => {});
      }
      return ready.hash;
    },
    onDrop: (drop) => {
      probe?.drops.push(drop);
      console.warn(`[gavin-shell] dropped ${JSON.stringify(drop)}`);
    },
  });
  const visitState = visits.state;
  const native = Capacitor.isNativePlatform();
  /// A debug build shows the keys panel, and says what the hub lists.
  let debugBuild = $state(false);
  let paired = $state<PairedWorkstation[]>([]);
  /// A debug build launched with a pairing code (scripts/pair.sh), which
  /// reads the pairing's steps off the device log.
  let scripted = false;
  /// A hub line of its own: an inbox item whose Workstation cannot be
  /// opened from this phone yet.
  let notice = $state<string | null>(null);

  const store = pairedStore(Workstations);
  const core = coreOnce(() => fetch(`${assets}/companion-core.wasm`).then((r) => r.arrayBuffer()));
  const pairing = phonePairFlow({
    keys: DeviceKeys,
    scanner: QrScanner,
    store,
    core,
    WebSocket: WebSocket as unknown as WebSocketConstructor,
    userAgent: navigator.userAgent,
    onChange: (list) => (paired = list),
    log: (line) => {
      if (scripted) console.log(line);
    },
  });
  const sheet = pairing.sheet;

  /// The Unlock, and a connection to each paired Workstation while it is
  /// held. Only in the app: a browser has no keys.
  const unlocked = native
    ? createUnlockedHub({
        keys: DeviceKeys,
        core,
        open: webSocketOpener(WebSocket as unknown as WebSocketConstructor),
        random: (n) => crypto.getRandomValues(new Uint8Array(n)),
        // A debug build says what the Unlock and each Workstation do.
        log: (line) => {
          if (debugBuild) console.log(line);
        },
      })
    : null;
  const unlockState = unlocked?.unlock;
  const live = unlocked?.live;
  $effect(() => {
    unlocked?.setPaired($state.snapshot(paired) as PairedWorkstation[]);
  });
  // The Unlock gates the connection, not the screen: a paired
  // Workstation's bundle would stay in front with its last data after
  // Face ID is declined or the app is backgrounded. Back to the hub, where
  // the Unlock is, and back to that Workstation once the Unlock is too.
  /// Not reactive: the effects below are what read and write it.
  let pendingReturn: PendingReturn | null = null;
  $effect(() => {
    if (!$unlockState || !leavesVisitOnLock($unlockState, $visitState)) return;
    pendingReturn = returnFor($visitState);
    void visits.close();
  });
  $effect(() => {
    if (!$unlockState) return;
    const step = stepReturn(pendingReturn, $unlockState, $visitState, hubWorkstations(paired, $live ?? {}), Date.now());
    pendingReturn = step.pending;
    if (step.open) void visits.open(step.open);
  });

  const inbox = $derived(
    $unlockState && connectionsAllowed($unlockState) && paired.length > 0 ? combinedInbox(paired, $live ?? {}) : null
  );

  /// The whole inbox, on a screen of its own (InboxList).
  let listing = $state(false);
  // Locked, or the last item dealt with: the list goes, or the next item
  // would bring it back unasked.
  $effect(() => {
    if (!inbox?.length) listing = false;
  });

  function openItem(row: InboxRow): void {
    const ws = hubWorkstations(paired, $live ?? {}).find((w) => w.id === row.workstationId);
    if (!ws) return;
    if (ws.openable) {
      void visits.open(ws, row.target ? { workspace: row.workspace, target: row.target } : null);
    } else {
      notice = `${ws.name} is not ready to open right now. At the desk: ${row.text}`;
    }
  }

  /// Notifications on this phone: checked at launch, asked for only on
  /// the owner's tap.
  let notifySetup = $state<NotifySetup>({ state: "checking" });
  const pushDeps = { push: Push, platform: Capacitor.getPlatform() === "android" ? "android" : "ios" } as const;
  function turnOnNotifications(): void {
    notifySetup = { state: "asking" };
    void setUpNotifications(pushDeps, true).then((setup) => (notifySetup = setup));
  }

  /// Each paired Workstation handed this phone's permission to notify it,
  /// once notifications are on and while it is connected.
  const handover = createHandover({
    client: gatewayClient((r) => Push.gateway(r)),
    hand: (id, permission) => {
      const connection = unlocked?.connectionSource(id).current();
      return connection ? handOver(connection, permission) : null;
    },
    keep: (record) => Push.keepRegistration({ record: JSON.stringify(record) }),
    now: () => Math.floor(Date.now() / 1000),
    log: (line) => {
      if (debugBuild) console.log(line);
    },
  });
  const handoverStatus = handover.status;
  $effect(() => {
    handover.use(notifySetup.state === "on" ? $state.snapshot(notifySetup.kept) : null);
  });
  // Again whenever a Workstation's state moves: one that just connected
  // is one that can be handed its permission now.
  $effect(() => {
    const states = Object.entries($live ?? {}).map(([id, s]) => `${id}:${s.state}`).join(" ");
    void states;
    handover.sync(paired.map((ws) => ws.id));
  });
  const notifyRows = $derived(
    notifySetup.state === "on"
      ? paired.map((ws) => ({
          id: ws.id,
          name: ws.name,
          word: notifyWord($handoverStatus[ws.id]),
          muted: $handoverStatus[ws.id] === "off",
        }))
      : []
  );

  /// A tapped notification, waiting for the Unlock and for its
  /// Workstation's connection. Not reactive, like `pendingReturn`.
  let tapped: PendingTap | null = null;
  function openTap(link: string): void {
    // Where the owner is going now, not back where the lock left them.
    pendingReturn = null;
    const landing = readNotifyLink(link);
    if (!landing) {
      // Nothing opened that push, or it was a resolve: it lands on the hub.
      tapped = null;
      void visits.close();
      return;
    }
    tapped = pendingTap(landing);
    if ($unlockState) stepTapped($unlockState);
  }
  function stepTapped(unlock: UnlockState): void {
    const step = stepTap(tapped, unlock, hubWorkstations(paired, $live ?? {}), Date.now());
    tapped = step.pending;
    if (step.notice) notice = step.notice;
    if (step.open) void visits.open(step.open.workstation, step.open.landing);
  }
  $effect(() => {
    if ($unlockState) stepTapped($unlockState);
  });

  // A notification about an item the desk has dealt with leaves the
  // screen once its Workstation answers without it -- whether or not its
  // resolve push arrived.
  let cleared = new Map<string, string>();
  $effect(() => {
    if (!native) return;
    const { clears, sent } = clearsFor($live ?? {}, cleared);
    cleared = sent;
    for (const clear of clears) void Push.clearDelivered(clear).catch(() => {});
  });

  async function loadPaired(): Promise<void> {
    try {
      paired = await store.list();
    } catch (e) {
      console.warn(`[gavin-shell] the paired Workstations could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  onMount(() => {
    if (native) {
      void BundleView.probeRequested()
        .catch(() => ({ probe: false }))
        .then(({ probe: wanted }) => {
          if (!wanted) return;
          probe = createProbeBench();
          return runProbe({ visits, bench: probe, timeoutMs: PROBE_TIMEOUT_MS, log: (line) => console.log(line) });
        });
      void DeviceKeys.status()
        .then(async (status) => {
          debugBuild = status.debugBuild;
          if (status.debugBuild) void DeviceKeys.addListener("trace", (e) => console.log(e.line)).catch(() => {});
          const { key: devKey } = await BundleView.devPublisherKey().catch(() => ({ key: null }));
          trusted = trustedKeys({ debugBuild: status.debugBuild, devKey });
          if (status.debugBuild) console.log(`[gavin-shell] trusts ${trusted.length} bundle key(s)`);
          await loadPaired();
          if (status.debugBuild) {
            console.log(`[gavin-shell] hub lists ${paired.length} paired: ${paired.map((ws) => ws.id).join(" ") || "none"}`);
          }
          // Once the pairings are read: a tap that launched the app names
          // one, and is held natively until this listens.
          void Push.addListener("opened", (tap) => {
            if (status.debugBuild) console.log(`[gavin-shell] notification tapped: ${tap.link}`);
            openTap(tap.link);
          }).catch(() => {});
          void setUpNotifications(pushDeps, false).then((setup) => {
            notifySetup = setup;
            if (status.debugBuild) console.log(`[gavin-shell] notifications: ${setup.state}`);
          });
          if (status.checkRequested) return runKeysCheck({ keys: DeviceKeys, log: (line) => console.log(line) });
          const { text } = await QrScanner.scriptedCode().catch(() => ({ text: null }));
          if (text) {
            // A debug launch to pair (scripts/pair.sh): its own prompt is
            // the only one, so the Unlock is not asked for as well.
            scripted = true;
            return pairing.startWith(text);
          }
          unlocked?.setPaired($state.snapshot(paired) as PairedWorkstation[]);
          await unlocked?.start();
        })
        .catch(() => {});
    }
    return () => {
      pairing.cancel();
      void visits.dispose();
      void unlocked?.dispose();
    };
  });
</script>

<Hub
  workstations={hubWorkstations(paired, $live ?? {})}
  visit={$visitState}
  {native}
  onOpen={(ws) => void visits.open(ws)}
  onTryNow={(ws) => unlocked?.tryNow(ws.id)}
  onDismiss={() => void visits.close()}
  onPair={native ? () => void pairing.start() : null}
  {inbox}
  onOpenItem={openItem}
  {listing}
  onList={(open) => (listing = open)}
  unlockNotice={$unlockState ? unlockNotice($unlockState, paired.length > 0) : null}
  onUnlock={() => unlocked?.requestUnlock()}
  {notice}
  onDismissNotice={() => (notice = null)}
  notifications={notifyLine(notifySetup)}
  onNotifications={turnOnNotifications}
  {notifyRows}
  onToggleNotify={(id, muted) => handover.setMuted(id, muted)}
>
  {#if debugBuild}
    <KeysPanel keys={DeviceKeys} />
  {/if}
</Hub>

<PairingSheet
  sheet={$sheet}
  onCancel={() => pairing.cancel()}
  onClose={() => pairing.close()}
  onRename={(name) => pairing.rename(name)}
/>
