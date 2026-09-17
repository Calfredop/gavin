<!--
  The one alert/confirm layer for the whole app, mounted once at the root
  (+page.svelte) beside ContextMenu. It is a template over dialog.ts and
  nothing else: the store holds the question, this draws it with the same
  ConfirmPrompt every board, column and settings panel already uses, and
  every answer goes straight back through answerDialog.

  An alert is the same modal with `confirmLabel: null` -- one button, no
  second answer -- rather than a second component, because two dialogs
  that look almost alike is exactly what this card set out to remove.
-->
<script lang="ts">
  import ConfirmPrompt from "$lib/core/ConfirmPrompt.svelte";
  import { dialogRequest, answerDialog } from "$lib/core/dialog";
</script>

{#if $dialogRequest}
  {@const req = $dialogRequest}
  <ConfirmPrompt
    title={req.title}
    lines={req.lines}
    cancelLabel={req.cancelLabel}
    check={req.check}
    picker={req.picker}
    block={req.block}
    choices={req.confirmLabel === null
      ? []
      : [
          {
            label: req.confirmLabel,
            danger: req.danger,
            onPick: (picked, checked) => answerDialog(req.id, true, checked, picked),
          },
        ]}
    onCancel={() => answerDialog(req.id, false)}
  />
{/if}
