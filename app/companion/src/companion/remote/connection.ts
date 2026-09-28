// The one channel this bundle speaks through.
//
// Module-level because the shim's `invoke` and `listen` are: the desktop's
// modules import them as plain functions and call them with no handle to
// pass, so where they go has to be a fact about the page. A bundle reaches
// exactly one Workstation (ADR 0005), which is what makes one slot the
// right number.
import { createChannelClient, type ChannelClient } from "$companion/channel/client";
import type { ChannelPort } from "$companion/channel/port";

let client: ChannelClient | null = null;

export const NOT_CONNECTED = "the channel is not connected";

/// Connects the bundle to its Workstation, closing whatever it was
/// connected to before.
export function connectChannel(port: ChannelPort): ChannelClient {
  client?.close();
  client = createChannelClient(port);
  return client;
}

export function disconnectChannel(): void {
  client?.close();
  client = null;
}

/// The channel, or null before `connectChannel`. The shim turns null into
/// a rejection rather than a throw, because the desktop's callers handle
/// a command that failed and none of them expect `invoke` itself to blow
/// up under them.
export function channel(): ChannelClient | null {
  return client;
}
