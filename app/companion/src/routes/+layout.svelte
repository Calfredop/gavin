<script lang="ts">
  // The desktop's one global stylesheet, and the phone's page rules after
  // it. Imported here rather than from a component <style> block because
  // Svelte scopes those, which would compile the :root rules away.
  import "$lib/ui/theme.css";
  import "$companion/surfaces/phone.css";

  let { children } = $props();
</script>

{@render children()}
