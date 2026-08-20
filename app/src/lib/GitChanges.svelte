<script lang="ts">
  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();
</script>

<div class="stub" data-workspace={workspaceId}></div>

<style>
  .stub {
    height: 100%;
  }
</style>
