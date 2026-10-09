// The Demo Workstation (CONTEXT.md): a simulated Workstation, answering
// the channel from sample data.
//
// It is the Workstation's END of the channel and nothing else -- it knows
// no transport, so the same object answers the bundle in a desktop
// browser, the shell's bundle webview on a phone, and the seam suites.
// "The demo that ships is also the fixture" (spec, Testing Decisions):
// there is no second, test-only Workstation to drift from this one.
import {
  CHANNEL_VERSION,
  CORE_MESSAGES,
  encode,
  NOT_REACHABLE,
  readBundleMessage,
  type BundleMessage,
  type ConnectionState,
  type Capabilities,
  type ErrorCode,
  type WorkstationMessage,
} from "$companion/channel/messages";
import type { ChannelEndpoint } from "$companion/channel/port";
import { ACTIVITY } from "$companion/demo/activity";
import { runCommitAgents } from "$companion/demo/agentCommit";
import { turnPage } from "$companion/demo/browser";
import { COMMANDS, DemoFailure, type DemoContext } from "$companion/demo/commands";
import { runAllRails } from "$companion/demo/railCommands";
import { DEMO, sampleState, type DemoState } from "$companion/demo/sampleData";
import { refusedToRemoteRole } from "$companion/remote/remoteRole";

/// The two acts on the channel that are not a Workstation's to perform.
/// Opening a link and going back to the hub belong to whoever HOSTS the
/// channel: the shell on a phone, the page itself in a desktop browser.
export interface DemoHost {
  /// Opens a web link outside the bundle. Throwing is how it says no.
  openExternal?: (url: string) => void;
  /// Leaves the Workstation for the Workstations hub.
  returnToHub?: () => void;
}

/// A host that can do both and does nothing: the suites', which only
/// need to see that the act was asked for.
const WILLING_HOST: DemoHost = { openExternal: () => {}, returnToHub: () => {} };

export interface DemoOptions {
  /// The message types this end carries. By default the core set,
  /// whichever acts the host can perform, and `connection`; given
  /// outright, it is how a suite plays a shell older than the bundle.
  messages?: readonly string[];
  host?: DemoHost;
  state?: DemoState;
}

export interface DemoWorkstation extends ChannelEndpoint, DemoContext {
  /// Set to play a Workstation that cannot be asked -- "desktop app not
  /// running" is what the daemon answers when nothing is there to
  /// forward to. The shell still answers for itself: `capabilities` is
  /// a question about the channel, not about the desk.
  unavailable: string | null;
  /// Plays the connection to this Workstation going down and coming back
  /// up, as a shell sees it: while it is down every call is refused as
  /// one that never reached the desk (`unreachable`) -- a listen is still
  /// taken, as the shell takes one -- and the bundle is told each change,
  /// when this end carries `connection`.
  reach(state: ConnectionState): void;
  /// Takes the next step of the demo's activity (activity.ts), which
  /// loops.
  advance(): void;
  /// Every command that arrived, by name, in order.
  commands(): string[];
  /// The commands among them the demo had no answer for.
  unanswered(): string[];
  /// Every message that arrived and could be read.
  received(): BundleMessage[];
  /// How many listeners are registered for an event.
  listening(event: string): number;
}

interface Listener {
  event: string;
  reply: (raw: string) => void;
}

export function createDemoWorkstation(options: DemoOptions = {}): DemoWorkstation {
  const host = options.host ?? WILLING_HOST;
  // In the message set's own order, so an end that carries everything
  // says so the way the set is written.
  const messages = options.messages ?? [
    ...CORE_MESSAGES,
    ...(host.openExternal ? ["open-external"] : []),
    ...(host.returnToHub ? ["return-to-hub"] : []),
    "connection",
  ];
  const state = options.state ?? sampleState();
  const received: BundleMessage[] = [];
  const unanswered: string[] = [];
  const listeners = new Map<number, Listener>();
  let step = 0;
  let reachable: ConnectionState = { state: "up" };
  /// How to reach the bundle unasked: the reply of the last message.
  let lastReply: ((raw: string) => void) | null = null;

  function send(reply: (raw: string) => void, message: WorkstationMessage): void {
    reply(encode(message));
  }

  function ok(reply: (raw: string) => void, id: number, value: unknown = null): void {
    send(reply, { v: CHANNEL_VERSION, type: "result", id, ok: true, value });
  }

  function fail(reply: (raw: string) => void, id: number, error: string, code?: ErrorCode): void {
    send(
      reply,
      code
        ? { v: CHANNEL_VERSION, type: "result", id, ok: false, error, code }
        : { v: CHANNEL_VERSION, type: "result", id, ok: false, error }
    );
  }

  const demo: DemoWorkstation = {
    state,
    unavailable: null,

    advance() {
      ACTIVITY[step % ACTIVITY.length](demo);
      // And the agent with a browser moves on a page, whatever else the
      // step did: the live view is what a phone opens it for.
      turnPage(demo);
      step += 1;
      // The desk's scheduler, as time passes at the desk: a card the
      // human moved to Done from the phone moves its rail on.
      runAllRails(demo);
      // ...and a commit agent the phone asked the desk for moves on,
      // after anything the step above changed, so its commit takes it.
      runCommitAgents(demo);
    },

    reach(next) {
      reachable = next;
      if (!lastReply || !messages.includes("connection")) return;
      send(lastReply, { v: CHANNEL_VERSION, type: "connection", ...next });
    },

    emit(event, payload) {
      for (const [id, listener] of listeners) {
        if (listener.event !== event) continue;
        send(listener.reply, { v: CHANNEL_VERSION, type: "event", listener: id, event, payload });
      }
    },

    receive(raw, reply) {
      lastReply = reply;
      const read = readBundleMessage(raw);
      if (read.kind === "malformed") {
        if (read.id !== null) fail(reply, read.id, read.reason);
        return;
      }
      if (read.kind === "unknown") {
        if (read.id !== null) fail(reply, read.id, read.type, "unsupported");
        return;
      }
      const message = read.message;
      if (!messages.includes(message.type)) {
        fail(reply, message.id, message.type, "unsupported");
        return;
      }
      received.push(message);
      switch (message.type) {
        case "capabilities": {
          const answer: Capabilities = {
            version: CHANNEL_VERSION,
            messages: [...messages],
            workstation: { ...DEMO.workstation },
          };
          ok(reply, message.id, answer);
          return;
        }
        case "invoke": {
          if (reachable.state === "down") {
            fail(reply, message.id, NOT_REACHABLE, "unreachable");
            return;
          }
          if (demo.unavailable !== null) {
            fail(reply, message.id, demo.unavailable);
            return;
          }
          // The gate first, as the daemon's is: refused before any
          // handler is looked up, let alone run.
          const refusal = refusedToRemoteRole(message.cmd);
          if (refusal) {
            fail(reply, message.id, refusal);
            return;
          }
          const command = COMMANDS[message.cmd];
          if (!command) {
            unanswered.push(message.cmd);
            fail(reply, message.id, `the Demo Workstation has no answer for "${message.cmd}"`);
            return;
          }
          try {
            ok(reply, message.id, command(message.args, demo) ?? null);
          } catch (e) {
            if (!(e instanceof DemoFailure)) throw e;
            fail(reply, message.id, e.message);
          }
          return;
        }
        case "listen":
          if (demo.unavailable !== null) {
            fail(reply, message.id, demo.unavailable);
            return;
          }
          listeners.set(message.id, { event: message.event, reply });
          ok(reply, message.id);
          return;
        case "unlisten":
          listeners.delete(message.listener);
          ok(reply, message.id);
          return;
        case "open-external":
        case "return-to-hub": {
          const act =
            message.type === "open-external"
              ? host.openExternal && (() => host.openExternal?.(message.url))
              : host.returnToHub;
          if (!act) {
            fail(reply, message.id, message.type, "unsupported");
            return;
          }
          try {
            act();
            ok(reply, message.id);
          } catch (e) {
            fail(reply, message.id, e instanceof Error ? e.message : String(e));
          }
          return;
        }
      }
    },

    commands: () => received.flatMap((m) => (m.type === "invoke" ? [m.cmd] : [])),
    unanswered: () => [...unanswered],
    received: () => [...received],
    listening: (event) => [...listeners.values()].filter((l) => l.event === event).length,
  };
  return demo;
}
