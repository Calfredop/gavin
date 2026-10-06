// The adopted-memory index, as the app asks the daemon about it.
//
// One reading per root, shared by the wizard's Memory step and the Home
// tab's step count, so a download started in one is seen by the other.
// Asked of the LOCAL daemon -- the one that holds the model and the
// index -- and only once it can answer: against one older than v60 it
// settles on the version it needs instead (`FEATURE_MIN_VERSION
// .memoryIndex`), so no step waits for ever on a question nobody can ask.
//
// Also the two moments the index is brought up without anyone opening
// the step: a workspace opened with memories the index does not match
// (`startMemoryBackfill`), and a memory just adopted (`syncAfterAdopt`).
//
// What a reading MEANS is memoryIndex.ts's. This module is the asking.

import { get, writable, type Readable } from "svelte/store";
import * as backend from "$lib/core/backend";
import { daemonCompat, layoutState } from "$lib/core/layoutState";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import {
  adoptIndexNotice,
  backfillWanted,
  loadMemorySkipped,
  memoryPollFast,
  type MemoryIndexStatus,
  type MemoryReading,
} from "$lib/cards/memoryIndex";

/// While the model downloads: the one state a human watches change.
export const FAST_POLL_MS = 1500;

const readings = writable<Record<string, MemoryReading>>({});

/// Every root's reading; a root not in it has not been answered yet.
export const memoryReadings: Readable<Record<string, MemoryReading>> = { subscribe: readings.subscribe };

/// One read. `undefined` when there is no daemon to ask yet -- not
/// connected is not an answer, and the caller keeps whatever it had.
export async function readMemoryIndex(
  compat: DaemonCompat | null,
  ask: () => Promise<MemoryIndexStatus>
): Promise<MemoryReading | undefined> {
  if (!compat) return undefined;
  const blocked = featureBlockedReason(compat, "memoryIndex");
  if (blocked) return { kind: "blocked", reason: blocked };
  try {
    return { kind: "status", status: await ask() };
  } catch (e) {
    return { kind: "error", message: messageOf(e) };
  }
}

function messageOf(e: unknown): string {
  return String(e instanceof Error ? e.message : e);
}

/// Per root, bumped by every read and every action, so an answer that
/// lands after a newer one was asked for is dropped: a slow status must
/// not paint over the download the human just started.
const tokens = new Map<string, number>();

function bump(root: string): number {
  const mine = (tokens.get(root) ?? 0) + 1;
  tokens.set(root, mine);
  return mine;
}

function settle(root: string, mine: number, next: MemoryReading | undefined): MemoryReading | undefined {
  if (tokens.get(root) !== mine || next === undefined) return undefined;
  readings.update((all) => ({ ...all, [root]: next }));
  return next;
}

export async function refreshMemoryIndex(root: string): Promise<MemoryReading | undefined> {
  const mine = bump(root);
  return settle(root, mine, await readMemoryIndex(get(daemonCompat), () => backend.getMemoryIndex(root)));
}

/// Every root a surface has asked about, re-asked on every connection --
/// the first, a reconnect, a restarted daemon that may be a different
/// version. Without it a root asked before the daemon answered would
/// stay unknown, and the setup it feeds pending, for good.
const asked = new Set<string>();
let following = false;

function follow(): void {
  if (following) return;
  following = true;
  daemonCompat.subscribe((compat) => {
    if (compat) for (const root of asked) void refreshMemoryIndex(root);
  });
}

/// A surface that needs a reading for `root`: asks unless what is held is
/// an answer worth keeping.
export function ensureMemoryReading(root: string): void {
  asked.add(root);
  if (!following) {
    follow();
    return;
  }
  const held = get(readings)[root];
  if (held === undefined || held.kind !== "status" || memoryPollFast(held)) {
    void refreshMemoryIndex(root);
  }
}

/// The Memory step's button: download the model if it is missing and
/// build the index. Answers at once with `downloading` while the model
/// is fetched; `watchMemoryIndex` follows it from there.
export async function prepareMemoryIndex(root: string): Promise<void> {
  const mine = bump(root);
  settle(root, mine, await readMemoryIndex(get(daemonCompat), () => backend.ensureMemoryIndex(root, true)));
}

/// A surface showing `root`'s index live. Polls only while the model is
/// downloading; returns the unwatch.
export function watchMemoryIndex(root: string): () => void {
  ensureMemoryReading(root);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watching = true;
  const unsubscribe = readings.subscribe((all) => {
    if (!watching || timer !== null || !memoryPollFast(all[root])) return;
    timer = setTimeout(() => {
      timer = null;
      if (watching) void refreshMemoryIndex(root);
    }, FAST_POLL_MS);
  });
  return () => {
    watching = false;
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
  };
}

/// After Adopt has written `### Learned`: index the new fact now, so the
/// next search finds it without a heal. A sentence for the modal when
/// that did not happen for a reason worth telling, null otherwise.
///
/// Silent where there is no index to update yet -- an older daemon, a
/// model nobody has downloaded (the human may have said "not now") --
/// because the adopt succeeded and the Memory step is where the model is
/// offered. The file is the store either way; the next search heals.
export async function syncAfterAdopt(
  root: string,
  deps: {
    compat: DaemonCompat | null;
    ensure: (root: string, download: boolean) => Promise<MemoryIndexStatus>;
    status: (root: string) => Promise<MemoryIndexStatus>;
  } = { compat: get(daemonCompat), ensure: backend.ensureMemoryIndex, status: backend.getMemoryIndex }
): Promise<string | null> {
  if (!deps.compat || featureBlockedReason(deps.compat, "memoryIndex")) return null;
  try {
    const status = await deps.ensure(root, false);
    readings.update((all) => ({ ...all, [root]: { kind: "status", status } }));
    return null;
  } catch (e) {
    const status = await deps.status(root).catch(() => null);
    if (status && status.model !== "ready") return null;
    return adoptIndexNotice(messageOf(e));
  }
}

export interface BackfillDeps {
  compat: DaemonCompat | null;
  skipped: (root: string) => boolean;
  read: (root: string) => Promise<MemoryReading | undefined>;
  ensure: (root: string) => Promise<MemoryReading | undefined>;
}

/// One workspace, opened: brings its index up when it has memories the
/// index does not match. Never throws -- a failed backfill is a reading
/// the Memory step shows, not a workspace that will not open.
export async function backfillRoot(root: string, deps: BackfillDeps): Promise<"ensured" | "none"> {
  if (!deps.compat || featureBlockedReason(deps.compat, "memoryIndex")) return "none";
  const skipped = deps.skipped(root);
  if (skipped) return "none";
  const reading = await deps.read(root).catch(() => undefined);
  if (!backfillWanted(reading, skipped)) return "none";
  const after = await deps.ensure(root).catch((e) => ({ kind: "error", message: messageOf(e) }) as const);
  if (after?.kind === "error") console.warn(`gavin: memory index backfill for ${root}: ${after.message}`);
  return "ensured";
}

/// Brings every local workspace's index up once per connection: on
/// launch, on a workspace added or opened, and again after the daemon
/// restarts (a newer one may be the first that can answer). Run by the
/// window holding the app's duties, so two windows do not race the same
/// download.
export function startMemoryBackfill(): () => void {
  let seen = new Set<string>();
  const deps = (): BackfillDeps => ({
    compat: get(daemonCompat),
    skipped: (root) => loadMemorySkipped(root),
    read: refreshMemoryIndex,
    ensure: async (root) => {
      await prepareMemoryIndex(root);
      return get(readings)[root];
    },
  });
  const sweep = () => {
    const state = get(layoutState);
    if (state.status !== "ready" || !get(daemonCompat)) return;
    for (const ws of state.workspaces) {
      const root = ws.rootPath;
      if (!root || ws.ssh || seen.has(root)) continue;
      seen.add(root);
      void backfillRoot(root, deps());
    }
  };
  const stops = [
    layoutState.subscribe(sweep),
    daemonCompat.subscribe(() => {
      seen = new Set();
      sweep();
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
