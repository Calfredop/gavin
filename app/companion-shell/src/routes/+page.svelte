<script lang="ts">
  // The shell's one page: the Workstations hub, and the visits it opens.
  // Every decision is in a module (visit.ts, shellChannel.ts, probe.ts,
  // keysCheck.ts); this wires them to the native views and draws the hub.
  import { onMount } from "svelte";
  import { Capacitor } from "@capacitor/core";
  import { hubWorkstations } from "$shell/hub/workstations";
  import { runKeysCheck } from "$shell/keys/keysCheck";
  import { BundleView } from "$shell/native/bundleView";
  import { DeviceKeys } from "$shell/native/deviceKeys";
  import { PROBE_WORKSTATION, createProbeBench, runProbe, type ProbeBench } from "$shell/probe/probe";
  import Hub from "$shell/surfaces/Hub.svelte";
  import KeysPanel from "$shell/surfaces/KeysPanel.svelte";
  import { endpointFor } from "$shell/visit/endpoints";
  import { createVisits } from "$shell/visit/visit";

  const PROBE_TIMEOUT_MS = 30_000;

  /// Set only while a debug build runs the bundle probe.
  let probe: ProbeBench | null = null;

  const visits = createVisits({
    view: BundleView,
    endpointFor: (ws) => (probe && ws.id === PROBE_WORKSTATION.id ? probe.visit : endpointFor(ws)),
    onDrop: (drop) => {
      probe?.drops.push(drop);
      console.warn(`[gavin-shell] dropped ${JSON.stringify(drop)}`);
    },
  });
  const visitState = visits.state;
  const native = Capacitor.isNativePlatform();
  /// A debug build shows the keys panel.
  let debugBuild = $state(false);

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
        .then((status) => {
          debugBuild = status.debugBuild;
          if (status.checkRequested) return runKeysCheck({ keys: DeviceKeys, log: (line) => console.log(line) });
        })
        .catch(() => {});
    }
    return () => void visits.dispose();
  });
</script>

<Hub
  workstations={hubWorkstations()}
  visit={$visitState}
  {native}
  onOpen={(ws) => void visits.open(ws)}
  onDismiss={() => void visits.close()}
>
  {#if debugBuild}
    <KeysPanel keys={DeviceKeys} />
  {/if}
</Hub>
