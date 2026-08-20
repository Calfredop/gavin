// The app's tooltip: a Svelte action (`use:tooltip={"text"}`) driving
// ONE lazily created, body-mounted bubble -- replacing native `title=`
// attributes (OS-delayed, unstyled). Zero layout impact on hosts, shows
// on hover (after a short delay) and on keyboard focus, hides instantly
// on leave/blur/pointerdown so drags and clicks never trail a stale
// bubble. Positioning: centered above the host, flipped below when the
// viewport clips it, clamped horizontally.

import type { Action } from "svelte/action";

const SHOW_DELAY_MS = 350;
const GAP_PX = 6;
const EDGE_PX = 4;

let bubble: HTMLDivElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let currentHost: Element | null = null;

function ensureBubble(): HTMLDivElement {
  if (bubble) return bubble;
  bubble = document.createElement("div");
  bubble.setAttribute("role", "tooltip");
  Object.assign(bubble.style, {
    position: "fixed",
    zIndex: "3000",
    pointerEvents: "none",
    background: "#1e1e1e",
    border: "1px solid #444",
    borderRadius: "4px",
    color: "#ddd",
    fontFamily: "monospace",
    fontSize: "11px",
    lineHeight: "1.4",
    padding: "3px 8px",
    maxWidth: "260px",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.45)",
    opacity: "0",
    transition: "opacity 100ms ease",
    whiteSpace: "pre-line",
    wordBreak: "break-word",
  });
  document.body.appendChild(bubble);
  return bubble;
}

function position(host: Element): void {
  if (!bubble) return;
  const hostRect = host.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  let left = hostRect.left + hostRect.width / 2 - bubbleRect.width / 2;
  left = Math.max(EDGE_PX, Math.min(left, window.innerWidth - bubbleRect.width - EDGE_PX));
  let top = hostRect.top - bubbleRect.height - GAP_PX;
  if (top < EDGE_PX) top = hostRect.bottom + GAP_PX;
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

function show(host: Element, text: string): void {
  if (!text) return;
  const el = ensureBubble();
  currentHost = host;
  el.textContent = text;
  // Place off-screen first so the size measurement never flashes.
  el.style.left = "-9999px";
  el.style.top = "0px";
  el.style.opacity = "1";
  position(host);
}

function hide(host?: Element): void {
  if (host && currentHost !== host) return;
  currentHost = null;
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (bubble) bubble.style.opacity = "0";
}

// use:tooltip={"the text"} — empty/null text disables it.
export const tooltip: Action<Element, string | null | undefined> = (node, text) => {
  let current = text ?? "";

  function schedule(): void {
    if (!current) return;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      show(node, current);
    }, SHOW_DELAY_MS);
  }

  function showNow(): void {
    if (current) show(node, current);
  }

  function cancel(): void {
    hide(node);
  }

  node.addEventListener("mouseenter", schedule);
  node.addEventListener("mouseleave", cancel);
  node.addEventListener("focus", showNow);
  node.addEventListener("blur", cancel);
  node.addEventListener("pointerdown", cancel);

  return {
    update(next: string | null | undefined) {
      current = next ?? "";
      if (currentHost === node) {
        if (current) show(node, current);
        else hide(node);
      }
    },
    destroy() {
      hide(node);
      node.removeEventListener("mouseenter", schedule);
      node.removeEventListener("mouseleave", cancel);
      node.removeEventListener("focus", showNow);
      node.removeEventListener("blur", cancel);
      node.removeEventListener("pointerdown", cancel);
    },
  };
};
