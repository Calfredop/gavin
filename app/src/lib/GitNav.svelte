<script lang="ts">
  import { FileDiff } from "@lucide/svelte";

  interface Props {
    count: number;
  }
  let { count }: Props = $props();
</script>

<!-- Fork's left rail. SP1 has one entry; SP2/SP3 append Branches, Remotes,
     Stashes and Worktrees sections here. -->
<nav class="nav">
  <button type="button" class="item active">
    <FileDiff size={13} />
    <span class="label">Local Changes</span>
    {#if count > 0}<span class="count">{count}</span>{/if}
  </button>
</nav>

<style>
  .nav {
    height: 100%;
    padding: 8px 6px;
    box-sizing: border-box;
    background: #161616;
    border-right: 1px solid #2f2f2f;
    font-family: monospace;
    font-size: 0.78em;
  }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: #bbb;
    cursor: pointer;
    text-align: left;
  }
  .item.active {
    background: #252525;
    color: #eee;
  }
  .label {
    flex: 1 1 auto;
  }
  .count {
    color: #8bc98b;
  }
</style>
