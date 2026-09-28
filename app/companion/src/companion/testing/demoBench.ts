// The seam suites' bench: the bundle's channel joined to a Demo
// Workstation, the way the page joins them when there is no shell.
import { loopback } from "$companion/channel/port";
import { connectChannel } from "$companion/remote/connection";
import {
  createDemoWorkstation,
  type DemoOptions,
  type DemoWorkstation,
} from "$companion/demo/workstation";

export function connectDemo(options?: DemoOptions): DemoWorkstation {
  const demo = createDemoWorkstation(options);
  connectChannel(loopback(demo));
  return demo;
}

/// Lets everything in flight land: each crossing of the in-page channel
/// is a microtask, and an answer that provokes another question is
/// several of them.
export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
