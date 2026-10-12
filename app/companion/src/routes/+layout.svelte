<script lang="ts">
  // The desktop's one global stylesheet, and the phone's page rules after
  // it. Imported here rather than from a component <style> block because
  // Svelte scopes those, which would compile the :root rules away.
  import { onMount } from "svelte";
  import "$lib/ui/theme.css";
  import "$companion/surfaces/phone.css";
  import { ensureRandomUUID } from "$companion/remote/randomUUID";
  import { followTextScale } from "$companion/surfaces/textScale";

  // Before any surface can act: the desktop's Git actions name their ops
  // with it (remote/randomUUID.ts).
  ensureRandomUUID();

  // The phone's text size, live: the root's `--text-scale`
  // (surfaces/textScale.ts).
  onMount(() => followTextScale());

  let { children } = $props();
</script>

{@render children()}
