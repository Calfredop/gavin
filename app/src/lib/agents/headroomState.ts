// Headroom's status, as the setup surfaces read it.
//
// One reading per window, shared by Settings' Headroom section, the
// workspace switch, the wizard's step and the Home tab's step count, so
// an Install pressed in one is seen by all of them. It is asked of the
// LOCAL daemon -- the one that has to execute Headroom -- and only once
// the daemon can answer: against one older than v46 it settles on the
// version it needs instead (`FEATURE_MIN_VERSION.headroomSetup`), which
// is what keeps the wizard's step from waiting for ever on a question
// nobody can ask.
//
// What each surface makes of the reading is `headroomSetup.ts`'s. This
// module is the asking, the four actions, and the polling while a
// surface is watching.

import { get, writable, type Readable } from "svelte/store";
import * as backend from "$lib/core/backend";
import { daemonCompat } from "$lib/core/layoutState";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import { askConfirm } from "$lib/core/dialog";
import { pickPath } from "$lib/workspace/picker";
import type { HeadroomStatus } from "$lib/agents/compression";
import {
  headroomUpdateConfirm,
  installRunning,
  type HeadroomReading,
} from "$lib/agents/headroomSetup";

/// While an install runs, or Headroom is loading its model: the two
/// states a human is watching change.
export const FAST_POLL_MS = 1500;
/// Otherwise, for running, the port and the lifetime total.
export const SLOW_POLL_MS = 5000;

const reading = writable<HeadroomReading | undefined>(undefined);

/// The reading, `undefined` until the first answer lands.
export const headroomReading: Readable<HeadroomReading | undefined> = { subscribe: reading.subscribe };

/// One read. `undefined` when there is no daemon to ask yet -- not
/// connected is not an answer, and the caller keeps whatever it had.
export async function readHeadroom(
  compat: DaemonCompat | null,
  ask: () => Promise<HeadroomStatus>
): Promise<HeadroomReading | undefined> {
  if (!compat) return undefined;
  const blocked = featureBlockedReason(compat, "headroomSetup");
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

/// Bumped by every read and every action, so an answer that lands after
/// a newer one was asked for is dropped: a slow status must not paint
/// over the install the human just started.
let token = 0;

export async function refreshHeadroom(): Promise<void> {
  const mine = ++token;
  const next = await readHeadroom(get(daemonCompat), backend.getHeadroomStatus);
  if (mine !== token || next === undefined) return;
  reading.set(next);
}

let following = false;

/// Reads on every connection -- the first, a reconnect, a restarted
/// daemon that may be a different version -- from the first time any
/// surface asks. The store answers at once with the connection in force.
function follow(): void {
  if (following) return;
  following = true;
  daemonCompat.subscribe((compat) => {
    if (compat) void refreshHeadroom();
  });
}

/// A surface that needs a reading and not a live one: the Home tab's
/// count, the workspace switch's notes. Asks again only where what is
/// held is not an answer worth keeping -- none yet, a failure, a daemon
/// that was too old, an install still running.
export function ensureHeadroomReading(): void {
  if (!following) {
    follow();
    return;
  }
  const held = get(reading);
  if (held === undefined || held.kind !== "status" || installRunning(held.status)) {
    void refreshHeadroom();
  }
}

let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/// Whether what is on screen is changing by itself right now.
export function pollFast(held: HeadroomReading | undefined): boolean {
  if (held?.kind !== "status") return false;
  const { status } = held;
  return installRunning(status) || (status.wanted && !status.ready);
}

function schedule(): void {
  if (timer !== null || watchers === 0) return;
  timer = setTimeout(
    () => {
      timer = null;
      void refreshHeadroom().finally(schedule);
    },
    pollFast(get(reading)) ? FAST_POLL_MS : SLOW_POLL_MS
  );
}

/// A surface showing Headroom live -- Settings' section, the wizard's
/// step. Returns the unwatch; the polling stops with the last watcher.
export function watchHeadroom(): () => void {
  ensureHeadroomReading();
  watchers += 1;
  schedule();
  let watching = true;
  return () => {
    if (!watching) return;
    watching = false;
    watchers -= 1;
    if (watchers === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/// One action, and the status it answers with. The error comes back to
/// the caller to show beside the button, and the reading is left as it
/// was: a refused Check again says nothing new about Headroom.
async function act(request: () => Promise<HeadroomStatus>): Promise<string | null> {
  const mine = ++token;
  try {
    const status = await request();
    if (mine === token) reading.set({ kind: "status", status });
    // An install answers at once with itself running. Whoever is
    // watching now polls fast; nobody watching is nobody to show.
    if (timer !== null && pollFast(get(reading))) {
      clearTimeout(timer);
      timer = null;
      schedule();
    }
    return null;
  } catch (e) {
    return messageOf(e);
  }
}

/// Install: the pinned version with uv, then the model prefetch.
export function installHeadroom(): Promise<string | null> {
  return act(backend.installHeadroom);
}

/// Update: the same install, asked first -- it restarts the proxy every
/// compressed agent is talking through. The prompt is `danger`, so it
/// opens with focus on Cancel. Resolves to null when nothing went wrong,
/// including when the human said no.
export async function updateHeadroom(status: HeadroomStatus): Promise<string | null> {
  if (!(await askConfirm(headroomUpdateConfirm(status)))) return null;
  return installHeadroom();
}

/// Check again: uv's directory, `PATH`, then whatever was located.
export function checkHeadroomAgain(): Promise<string | null> {
  return act(() => backend.detectHeadroom());
}

/// Locate…: the file picker the wizard uses for an existing CLAUDE.md,
/// and the file picked is remembered from then on. Nothing picked is
/// nothing done.
export async function locateHeadroom(): Promise<string | null> {
  let picked: string | null;
  try {
    picked = await pickPath({ title: "Locate the headroom program" });
  } catch (e) {
    return messageOf(e);
  }
  if (!picked) return null;
  const path = picked;
  return act(() => backend.detectHeadroom(path));
}
