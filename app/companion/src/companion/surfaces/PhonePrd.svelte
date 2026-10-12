<script lang="ts">
  // The workspace's PRD, to read (spec, story 52): what every card on the
  // board traces back to. The file the desk's PRD tab edits, read here and
  // kept current while it is open.
  import { gavinTrees } from "$lib/core/gavinState";
  import type { Workspace } from "$lib/core/workspace";
  import { followFile } from "$companion/state/cards";
  import { closePage } from "$companion/state/workstation";
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";
  import PhoneMarkdown from "$companion/surfaces/PhoneMarkdown.svelte";
  import { prdPathOf } from "$companion/surfaces/phoneCard";

  interface Props {
    workspace: Workspace;
  }
  let { workspace }: Props = $props();

  const path = $derived(prdPathOf(workspace.rootPath, $gavinTrees[workspace.id]));
  /// Undefined while it is being read; null for a file that is not there.
  let content = $state<string | null | undefined>(undefined);

  $effect(() => {
    if (!path) return;
    content = undefined;
    const reading = followFile(path, (next) => (content = next));
    return () => reading.stop();
  });
</script>

<PhoneHeader title="PRD" back="Board" onBack={closePage} />
<div class="scroll">
  {#if !path}
    <p class="note">This workspace is bound to no folder, so it has no PRD.</p>
  {:else if content === undefined}
    <p class="note">Reading the PRD…</p>
  {:else if content === null || content.trim() === ""}
    <p class="note">
      This workspace has no PRD yet. Write one at the desk; it lives at <code>{path}</code>.
    </p>
  {:else}
    <article class="document">
      <PhoneMarkdown {content} />
    </article>
  {/if}
</div>

<style>
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .document {
    padding: 16px 16px calc(24px + env(safe-area-inset-bottom));
  }
  .note {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
</style>
