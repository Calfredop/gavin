<script lang="ts">
  // The app icon, live: appIconCanvas.ts draws it, this only mounts the
  // canvas and keeps the frames coming -- at CALM_FPS normally, every
  // display frame while a double click's punch plays. Reduce Motion keeps
  // every state but stills it.
  import { onMount } from "svelte";
  import { liveIcon } from "$lib/ui/appIconCanvas";
  import { CALM_FPS, type IconStatus } from "$lib/ui/appIconMotion";

  let { status, size = 64 }: { status: IconStatus; size?: number } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const icon = liveIcon(reduced);

  onMount(() => {
    let raf = 0;
    let last = -Infinity;
    function frame(now: number): void {
      raf = requestAnimationFrame(frame);
      if (!icon.shaking(now) && now - last < 1000 / CALM_FPS) return;
      const dt = Math.min(250, now - last);
      last = now;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(size * dpr);
      if (canvas.width !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      icon.frame(ctx, size, status, now, dt);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });
</script>

<canvas
  bind:this={canvas}
  style:width="{size}px"
  style:height="{size}px"
  aria-hidden="true"
  onpointerdown={() => icon.press(performance.now())}
></canvas>

<style>
  canvas {
    display: block;
    flex: 0 0 auto;
  }
</style>
