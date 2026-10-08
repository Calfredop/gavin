<script lang="ts">
  // The desktop's one global stylesheet, and the page rules the bundle
  // draws on: the hub and a Workstation's UI are one app to the eye.
  import { onMount } from "svelte";
  import "$lib/ui/theme.css";
  import "$companion/surfaces/phone.css";
  import { followTextScale } from "$companion/surfaces/textScale";

  let { children } = $props();

  // The hub has no Workstation to hold a theme preference, so it follows
  // the phone's, live.
  onMount(() => {
    const light = window.matchMedia("(prefers-color-scheme: light)");
    const apply = (): void => {
      document.documentElement.dataset.theme = light.matches ? "light" : "dark";
    };
    light.addEventListener("change", apply);
    return () => light.removeEventListener("change", apply);
  });

  // The phone's text size, live, as the bundle follows it too.
  onMount(() => followTextScale());
</script>

{@render children()}
