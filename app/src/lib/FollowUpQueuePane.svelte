<script lang="ts">
  // The follow-up queue living in a pane, split beside the terminal it
  // belongs to -- the third view a terminal tab can ask for, next to the
  // card's plan and the diff of what its run changed.
  //
  // Deliberately thin, like CardTabPane: it resolves the session's name
  // and hands the work to FollowUpQueueView, so the queue never has two
  // different faces depending on which host mounted it.
  import FollowUpQueueView from "$lib/FollowUpQueueView.svelte";
  import { layoutState, closeSession } from "$lib/layoutState";
  import { sessionLabel } from "$lib/paths";

  interface Props {
    /// The session whose queue this is -- NOT the tab it sits in. The two
    /// differ on purpose: the queue belongs to the terminal the human
    /// split this off from, and closing this pane must not touch it.
    sessionId: string;
    visible: boolean;
    /// The tab this pane occupies, so the view's own close can close it.
    tabId: string;
  }
  let { sessionId, visible, tabId }: Props = $props();

  // The contract every pane honors: Pane.svelte calls fit() on all of
  // them. A queue has nothing to fit.
  export function fit(): void {}

  // The same name the terminal's own tab wears, from the same helper, so
  // one session never goes by two names.
  const name = $derived(
    sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId)
  );
</script>

<div class="pane" style:display={visible ? "block" : "none"}>
  <FollowUpQueueView {sessionId} sessionName={name} inline onClose={() => closeSession(tabId)} />
</div>

<style>
  /* Positioned, because Modal's inline mode fills its nearest positioned
     ancestor. Same absolute-inset shape as every other pane. */
  .pane {
    position: absolute;
    inset: 0;
    background: var(--surface-base);
    color: var(--text);
    overflow: hidden;
  }
</style>
