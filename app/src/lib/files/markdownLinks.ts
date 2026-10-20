// Decision for a click inside sanitized markdown: never let the webview
// navigate. Only http(s) leaves, through the system browser (ADR 0005).
// The sinks attach this; the host's navigation-guard is the backstop.

/// Return the URL to open externally, or null when the click should only
/// be cancelled. Always preventDefault when the target is an anchor.
export function markdownLinkClick(event: MouseEvent): string | null {
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!link) return null;
  event.preventDefault();
  return hrefToOpen(link.getAttribute("href") ?? "");
}

/// Pure half: which hrefs may leave the app.
export function hrefToOpen(href: string): string | null {
  if (/^https?:\/\//i.test(href)) return href;
  return null;
}
