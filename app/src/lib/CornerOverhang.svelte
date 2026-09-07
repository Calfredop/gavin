<script lang="ts">
  // The room the window's corner needs at the head of whichever header
  // row is the top edge of the window.
  //
  // The corner (TitleBar.svelte) is positioned over the rail's top-left
  // and is as wide as `max(the platform's controls, the rail)`. Over an
  // open column those are the same edge and this box is zero. Over a
  // collapsed one the rail is 36px and the controls are not, so the
  // corner hangs into THIS row -- and this is the box that keeps the
  // row's first tab out from under it.
  //
  // A box rather than a padding rule on each row: there are three rows
  // that can be the window's top edge (the hub tabs, a page's session
  // tabs, and the strip +page.svelte draws for the branches with
  // neither), and one of them is in a different file. One instance per
  // window -- Pane.svelte draws it on the pane that LEADS the page
  // (layout.ts's paneLeadsWindow), so on a split page it is still in the
  // corner rather than wherever the keyboard happens to be.
</script>

<div class="corner-overhang"></div>

<style>
  .corner-overhang {
    flex: 0 0 auto;
    width: max(0px, calc(var(--window-corner-width) - var(--rail-width)));
  }
</style>
