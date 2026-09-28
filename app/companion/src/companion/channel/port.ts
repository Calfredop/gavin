// The two ends of the channel, as code sees them.
//
// Messages cross as STRINGS. Between a bundle's webview and the shell
// there is a native boundary that carries nothing richer, and holding the
// in-process route to the same rule is what makes the Demo Workstation an
// honest fixture: a payload that would not survive the real crossing does
// not survive this one either.

/// The bundle's end: strings out, strings in.
export interface ChannelPort {
  post(raw: string): void;
  /// Registers the receiver and returns its teardown. One receiver per
  /// port -- the channel client is the only thing that ever reads one.
  receive(handler: (raw: string) => void): () => void;
}

/// The Workstation's end. `reply` reaches the bundle that sent `raw`, and
/// stays valid afterwards: it is also how an event arrives, long after
/// the `listen` that asked for it was answered.
export interface ChannelEndpoint {
  receive(raw: string, reply: (raw: string) => void): void;
}

/// Joins a bundle's port to an endpoint in the same page.
///
/// Each crossing waits one microtask. A real channel is never
/// synchronous, and code that only works when the answer arrives before
/// `post` returns would pass here and hang in the shell. A microtask and
/// never a timer: a detached `setTimeout` throws in WKWebView.
export function loopback(endpoint: ChannelEndpoint): ChannelPort {
  let handler: ((raw: string) => void) | null = null;
  const reply = (raw: string): void => {
    queueMicrotask(() => handler?.(raw));
  };
  return {
    post(raw) {
      queueMicrotask(() => endpoint.receive(raw, reply));
    },
    receive(h) {
      handler = h;
      return () => {
        if (handler === h) handler = null;
      };
    },
  };
}

/// What the shell puts in the bundle's page, as `window.gavinChannel`.
///
/// The shape is the one Android's `WebViewCompat.addWebMessageListener`
/// injects -- which is also the API that gates a listener by origin, the
/// rule ADR 0005 asks for -- and the iOS shell installs an object of the
/// same shape over its script message handler. `data` is the message.
export interface ShellChannel {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export const SHELL_CHANNEL_NAME = "gavinChannel";

/// The port onto the shell's channel, or null where there is no shell:
/// a desktop browser, where the bundle runs against the Demo Workstation
/// in its own page.
export function shellPort(scope: object = globalThis): ChannelPort | null {
  const shell = (scope as Record<string, unknown>)[SHELL_CHANNEL_NAME];
  if (typeof shell !== "object" || shell === null) return null;
  const channel = shell as ShellChannel;
  if (typeof channel.postMessage !== "function") return null;
  return {
    post(raw) {
      channel.postMessage(raw);
    },
    receive(handler) {
      const onmessage = (event: { data: unknown }): void => {
        if (typeof event?.data === "string") handler(event.data);
      };
      channel.onmessage = onmessage;
      return () => {
        if (channel.onmessage === onmessage) channel.onmessage = null;
      };
    },
  };
}
