<script lang="ts">
  import type { PlanCardView } from "./planBoard";
  import { FileText, TriangleAlert } from "@lucide/svelte";

  interface Props {
    plan: PlanCardView;
    onOpen: () => void;
  }
  let { plan, onOpen }: Props = $props();

  // Pointer-driven opening lives in kanbanDragGlue (click-vs-drag
  // threshold); this covers the keyboard path only.
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  }
</script>

<div class="card" role="button" tabindex="0" onkeydown={handleKeydown}>
  <div class="header">
    <span class="glyph" title="Plan file"><FileText size={11} /></span>
    {#if plan.priority && plan.priority !== "none"}
      <span class="priority priority-{plan.priority}" title="Priority: {plan.priority}"></span>
    {/if}
    {#if plan.parseWarning}
      <span class="warning" title="This plan's frontmatter has issues"><TriangleAlert size={11} /></span>
    {/if}
  </div>
  <div class="title">{plan.title}</div>
  <div class="context-badge" title={plan.id}>{plan.contextName}</div>
</div>

<style>
  .card {
    background: #262b26;
    border: 1px dashed #4c584c;
    border-radius: 6px;
    padding: 8px;
    margin-bottom: 6px;
    cursor: pointer;
    color: #eee;
    font-family: monospace;
    font-size: 0.85em;
    user-select: none;
    -webkit-user-select: none;
    transition: box-shadow 120ms, border-color 120ms;
  }
  .card:hover {
    border-color: #5e6e5e;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .glyph {
    display: flex;
    align-items: center;
    color: #8bc98b;
  }
  .priority {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .priority-low {
    background: #6b8e6b;
  }
  .priority-medium {
    background: #d9a648;
  }
  .priority-high {
    background: #d97748;
  }
  .priority-urgent {
    background: #d94848;
  }
  .warning {
    display: flex;
    align-items: center;
    color: #d9a648;
    margin-left: auto;
  }
  .title {
    word-break: break-word;
  }
  .context-badge {
    display: inline-block;
    border: 1px solid #4c584c;
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 0.8em;
    color: #8bc98b;
    margin-top: 6px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    box-sizing: border-box;
  }
</style>
