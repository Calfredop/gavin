// The part of the screen the page can actually use.
//
// When the soft keyboard comes up, iOS shrinks the VISUAL viewport and
// leaves the layout viewport where it was, so a page sized to `100dvh`
// keeps drawing its bottom -- the compose field, the terminal's last rows
// -- underneath the keyboard. The bundle sizes itself to the visual
// viewport instead, and the terminal inside it refits to what is left,
// which is also what sends the PTY its new size (ticket 01, amendment 5).
// Measured on the typing bench: about 31 rows on an iPhone 17 with the
// keyboard down, about 13 with it up.

/// A keyboard is at least this tall; a smaller difference is the browser's
/// own bars coming and going.
const KEYBOARD_PX = 120;

export interface VisibleArea {
  height: number;
  /// How far iOS has scrolled the page to bring a focused field into
  /// view, which the page undoes by drawing itself that much lower.
  top: number;
  keyboard: boolean;
}

export function visibleArea(
  viewport: { height: number; offsetTop: number } | null | undefined,
  innerHeight: number
): VisibleArea {
  if (!viewport) return { height: innerHeight, top: 0, keyboard: false };
  return {
    height: Math.min(viewport.height, innerHeight),
    top: Math.max(0, viewport.offsetTop),
    keyboard: innerHeight - viewport.height > KEYBOARD_PX,
  };
}

interface Scope {
  innerHeight: number;
  visualViewport?: (EventTarget & { height: number; offsetTop: number }) | null;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
  document: { documentElement: HTMLElement };
}

/// Keeps `--visible-height` and `--visible-top` on the root element, and
/// `data-keyboard` while the keyboard is up. Returns its own teardown.
export function trackVisibleArea(scope: Scope = globalThis as unknown as Scope): () => void {
  const root = scope.document.documentElement;
  const sync = (): void => {
    const area = visibleArea(scope.visualViewport, scope.innerHeight);
    root.style.setProperty("--visible-height", `${area.height}px`);
    root.style.setProperty("--visible-top", `${area.top}px`);
    root.toggleAttribute("data-keyboard", area.keyboard);
  };
  sync();
  scope.visualViewport?.addEventListener("resize", sync);
  scope.visualViewport?.addEventListener("scroll", sync);
  scope.addEventListener("resize", sync);
  return () => {
    scope.visualViewport?.removeEventListener("resize", sync);
    scope.visualViewport?.removeEventListener("scroll", sync);
    scope.removeEventListener("resize", sync);
  };
}
