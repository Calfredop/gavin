// The shell's side of the bundle channel (spec "The Companion shell",
// ADR 0005 "Store compliance").
//
// A Workstation's UI bundle runs in a webview with no native bridge, and
// this is where its one outlet ends. Three rules, each held here and not
// left to the bundle:
//
// - **Its origin.** A message counts only if it came from the bundle's own
//   origin. The native side already refuses every other frame and origin
//   before a message reaches this page; checking again here is what makes
//   that a property of the channel rather than of two platforms' code.
// - **The closed set.** Only the message types in `MESSAGE_TYPES` are
//   carried, and only `result` and `event` come back. Anything else is
//   answered `unsupported` or dropped -- never passed on for someone else
//   to interpret, because a message the shell passes on unread is a native
//   capability a downloaded bundle could name (Guideline 4.7.2).
// - **One Workstation.** A channel is made for one bundle and bound to
//   one Workstation's end; `invoke`, `listen` and `unlisten` go there and
//   nowhere else. Opening a link and going back to the hub are the shell's
//   own acts and never reach a Workstation at all.
import {
  CHANNEL_VERSION,
  MESSAGE_TYPES,
  encode,
  readBundleMessage,
  readWorkstationMessage,
  type Capabilities,
  type ErrorCode,
  type Landing,
} from "$companion/channel/messages";
import type { ChannelEndpoint } from "$companion/channel/port";

/// What the shell does on a bundle's behalf. Rejecting (or throwing) is
/// how either says it did not happen.
export interface ShellActs {
  /// Opens a web link in the system browser. Only ever handed an http or
  /// https URL.
  openExternal(url: string): Promise<void> | void;
  /// Leaves the Workstation for the Workstations hub.
  returnToHub(): Promise<void> | void;
}

/// Why a message went nowhere. For the logs and the probe; the bundle is
/// told nothing, since there is nobody legitimate to tell.
export interface Drop {
  reason: "origin" | "closed" | "unknown" | "malformed";
  origin: string;
}

export interface ShellChannelOptions {
  /// The one origin the bundle is served from. Compared exactly.
  origin: string;
  /// The Workstation this channel reaches, as `capabilities` names it.
  workstation: Capabilities["workstation"];
  /// Where the bundle should land once open -- an inbox item's session
  /// or card -- handed over in the first `capabilities` answer and then
  /// forgotten, so a bundle that asks again (a reload) lands nowhere in
  /// particular.
  landing?: Landing | null;
  /// That Workstation's end of the channel.
  endpoint: ChannelEndpoint;
  acts: ShellActs;
  /// Hands a message to the bundle.
  deliver(raw: string): void;
  onDrop?(drop: Drop): void;
}

export interface ShellChannel {
  /// A message from the bundle's webview, with the origin the native side
  /// saw it come from.
  receive(raw: string, origin: string): void;
  /// Ends the channel. Nothing is carried either way afterwards, including
  /// answers the Workstation was still working on.
  close(): void;
}

/// Only a web link leaves the app. The bundle's client checks the same
/// thing; the shell is the end that must.
export function isWebLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function createShellChannel(options: ShellChannelOptions): ShellChannel {
  const { origin, workstation, endpoint, acts, deliver, onDrop } = options;
  let landing = options.landing ?? null;
  let closed = false;

  function toBundle(raw: string): void {
    if (!closed) deliver(raw);
  }

  function ok(id: number, value: unknown = null): void {
    toBundle(encode({ v: CHANNEL_VERSION, type: "result", id, ok: true, value }));
  }

  function fail(id: number, error: string, code?: ErrorCode): void {
    toBundle(
      encode(
        code
          ? { v: CHANNEL_VERSION, type: "result", id, ok: false, error, code }
          : { v: CHANNEL_VERSION, type: "result", id, ok: false, error }
      )
    );
  }

  /// What the Workstation says, on its way to the bundle: an answer or an
  /// event, and nothing else of the set -- the other types are the
  /// bundle's to send.
  function fromWorkstation(raw: string): void {
    const read = readWorkstationMessage(raw);
    if (read.kind !== "message") return;
    toBundle(raw);
  }

  async function perform(id: number, act: () => Promise<void> | void): Promise<void> {
    try {
      await act();
      ok(id);
    } catch (e) {
      fail(id, e instanceof Error ? e.message : String(e));
    }
  }

  return {
    receive(raw, from) {
      if (closed) {
        onDrop?.({ reason: "closed", origin: from });
        return;
      }
      if (from !== origin) {
        onDrop?.({ reason: "origin", origin: from });
        return;
      }
      const read = readBundleMessage(raw);
      if (read.kind === "malformed") {
        if (read.id !== null) fail(read.id, read.reason);
        else onDrop?.({ reason: "malformed", origin: from });
        return;
      }
      if (read.kind === "unknown") {
        if (read.id !== null) fail(read.id, read.type, "unsupported");
        else onDrop?.({ reason: "unknown", origin: from });
        return;
      }
      const message = read.message;
      switch (message.type) {
        case "capabilities": {
          const answer: Capabilities = {
            version: CHANNEL_VERSION,
            messages: [...MESSAGE_TYPES],
            workstation: { ...workstation },
          };
          if (landing) {
            answer.landing = landing;
            landing = null;
          }
          ok(message.id, answer);
          return;
        }
        case "invoke":
        case "listen":
        case "unlisten":
          // Re-encoded from what was read, so what reaches the
          // Workstation is exactly the message the shell understood.
          endpoint.receive(encode(message), fromWorkstation);
          return;
        case "open-external": {
          const url = message.url;
          if (!isWebLink(url)) {
            fail(message.id, "only a web link opens outside the app");
            return;
          }
          void perform(message.id, () => acts.openExternal(url));
          return;
        }
        case "return-to-hub":
          // Answered BEFORE it happens: going back ends this channel, and
          // an answer sent after that would reach nobody -- leaving the
          // bundle's call waiting in a view that is on its way out.
          ok(message.id);
          void Promise.resolve()
            .then(() => acts.returnToHub())
            .catch(() => {});
          return;
      }
    },

    close() {
      closed = true;
    },
  };
}
