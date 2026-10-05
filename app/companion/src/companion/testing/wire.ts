// Reading what the bundle sent, for the suites that hold a surface's
// actions to their channel traffic.
import type { BundleMessage } from "$companion/channel/messages";
import type { DemoWorkstation } from "$companion/demo/workstation";

function said(message: BundleMessage): string {
  switch (message.type) {
    case "invoke":
      return `invoke ${message.cmd}`;
    case "listen":
      return `listen ${message.event}`;
    default:
      return message.type;
  }
}

/// A point in the traffic to read on from.
export function mark(demo: DemoWorkstation): number {
  return demo.received().length;
}

/// Everything sent since `from`, one line a message: `invoke git_commit`,
/// `listen git-op-progress`, `unlisten`.
export function traffic(demo: DemoWorkstation, from = 0): string[] {
  return demo.received().slice(from).map(said);
}

/// The arguments of every `invoke` of `cmd` since `from`, in order.
export function argsOf(demo: DemoWorkstation, cmd: string, from = 0): Record<string, unknown>[] {
  return demo
    .received()
    .slice(from)
    .flatMap((m) => (m.type === "invoke" && m.cmd === cmd ? [m.args] : []));
}
