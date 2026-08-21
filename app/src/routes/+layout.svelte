<script lang="ts">
  // The app's only global stylesheet. Imported here rather than from a
  // component <style> block because Svelte scopes those, which would
  // compile the :root rules away.
  import "$lib/ui/theme.css";

  let { children } = $props();
</script>

{@render children()}
