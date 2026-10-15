// The ways in to a Workstation a phone was given -- its direct addresses
// (ADR 0009) and its Relays -- and what to say when none carried the
// stream: which way failed, and how.

/// `host:port` of a `ws://` or `wss://` URL, lowercased, with the
/// scheme's own port when none is written. Null when it cannot be read.
export function authorityOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "ws:" && scheme !== "wss:") return null;
  const port = parsed.port !== "" ? parsed.port : scheme === "wss:" ? "443" : "80";
  return `${parsed.hostname.toLowerCase()}:${port}`;
}

/// Whether a Relay URL is one of the Workstation's direct addresses: the
/// same host and port. A desk that named its own direct port as its
/// Relay (2026-10-14) gave a phone the listener twice, once under the
/// wrong name; dialled as a Relay it is a TLS port that speaks no Relay.
export function relayIsDirectPort(relayUrl: string, direct: readonly string[]): boolean {
  const relay = authorityOf(relayUrl);
  return relay !== null && direct.some((url) => authorityOf(url) === relay);
}

/// What the line says about a Relay URL that is a direct port.
export function directPortAsRelay(relayUrl: string): string {
  return `Its Relay URL, ${relayUrl}, is the Workstation’s own direct port, not a Relay. Set the Relay’s own port at the desk, then pair again.`;
}

/// What the line says when the Workstation's own listener refused the
/// token. While the desk holds an admission token the direct connection
/// asks for it as the Relay does (ADR 0009, amended 2026-10-15), so a
/// phone paired before that, or before the token was changed, is turned
/// away there until it pairs again -- and must be told so, not left on
/// the Relay's words for it.
export const DIRECT_ADMISSION_REFUSED =
  "It turned the direct connection away: it now asks for the desk’s admission token, and this phone holds an older one or none. Pair again to connect directly.";

/// The same, for a pairing: the code was drawn with a token the desk has
/// since changed or cleared.
export const DIRECT_ADMISSION_REFUSED_PAIRING =
  "The Workstation turned the pairing away: the admission token in this code is not the desk’s any more. Draw a new code at the desk and scan it again.";

/// What the line says when a Relay turned this phone's token away: it was
/// changed -- refreshed at the desk while this phone was away longer than
/// the old one was kept, or reissued by whoever runs the Relay -- and the
/// new one reaches a phone only by pairing again.
export const RELAY_ADMISSION_REFUSED =
  "Its Relay no longer accepts this phone’s admission token: it was changed while this phone was away. Pair again to get the new one.";

/// The token in a `RelayAdmissionChanged` push (v73): the desk refreshed
/// the token it minted and is handing this phone the new one, before the
/// old one stops working. Null for any other message.
export function refreshedAdmission(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  return m.type === "RelayAdmissionChanged" && typeof m.token === "string" && m.token !== "" ? m.token : null;
}

/// One sentence for every way in that was tried, in the order tried, so
/// the human reads which failed and how -- not only the last. Direct
/// addresses nothing answered are said together: they fail for one
/// reason, a phone that is not on that network.
export class Missed {
  private readonly direct: string[] = [];
  private readonly said: string[] = [];

  directUnreachable(url: string): void {
    this.direct.push(url);
  }

  say(sentence: string): void {
    this.said.push(sentence);
  }

  line(): string {
    const direct =
      this.direct.length === 0
        ? []
        : [
            `Could not reach it directly at ${this.direct.join(" or ")}. Is this phone on the same network or tailnet as the Workstation?`,
          ];
    return [...direct, ...this.said].join(" ");
  }
}
