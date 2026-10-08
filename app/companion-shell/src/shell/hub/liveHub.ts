// The live hub: one connection to each paired Workstation while the
// Unlock allows it, and what each one answers (spec, "The Workstations
// hub"; ADR 0004).
//
// - **Allowed** (`setAllowed(true)`, the Unlock held): every Workstation
//   not connected is connected, each signing under the Unlock without a
//   prompt, and asked what is waiting -- straight away, and every
//   `pollMs` after.
// - **A dropped connection, or one that could not be made, is tried
//   again**, sooner at first and then less often (`reconnectDelay`), with
//   no prompt: it signs under the same Unlock. A Workstation that refused
//   this Device for good is not tried again until the next Unlock.
// - **The owner asking** (`tryNow`, `refresh`: a tap on its row, the app
//   back in front) tries it now -- dials one that is waiting, asks one
//   that is connected -- without waiting out the backoff. Not more often
//   than once in `tryNowGapMs`, and without starting the count over: if
//   it fails, the loop carries on where it was, so a Relay is not dialled
//   from 1 s again on every tap.
// - **Not allowed** (`setAllowed(false)`, the Unlock ended): every
//   attempt stops, every connection is dropped, and every Workstation is
//   locked.
// - **A connection that finds the Unlock gone** says so (`onNotHeld`,
//   `onLapsed`): that is the Unlock's to act on, not this hub's.
//
// No state here is compared by identity: each Workstation's attempts
// carry a generation, and an answer from an older one is ignored.
import type { AttentionAnswer } from "$shell/connection/attention";
import { refusalIsFinal, type Connection, type ConnectOutcome, type ConnectTarget } from "$shell/connection/connection";
import { ATTENTION_POLL_MS, RECONNECT, reconnectDelay, TRY_NOW_GAP_MS, type LiveState } from "$shell/hub/live";
import type { PairedWorkstation } from "$shell/hub/paired";

export interface LiveHubDeps {
  connect(target: ConnectTarget, signal: AbortSignal): Promise<ConnectOutcome>;
  ask(connection: Connection): Promise<AttentionAnswer>;
  now(): number;
  /// Runs `fn` after `ms`; returns how to cancel it.
  after(ms: number, fn: () => void): () => void;
  onChange(live: Record<string, LiveState>): void;
  /// A Workstation's connection came up (`connection`) or went away
  /// (`null`): what a visit to it invokes and listens over (companion-23).
  onConnection?(id: string, connection: Connection | null): void;
  /// A new connection found no Unlock held natively.
  onNotHeld(): void;
  /// A new connection found the Unlock no longer covers it.
  onLapsed(): void;
  pollMs?: number;
  reconnect?: typeof RECONNECT;
  tryNowGapMs?: number;
  log?(line: string): void;
}

export interface LiveHub {
  /// The Workstations to keep connected: new ones are added (and
  /// connected, if allowed), gone ones dropped.
  setPaired(records: PairedWorkstation[]): void;
  setAllowed(allowed: boolean): void;
  /// `tryNow` for every Workstation: the app came back to the front.
  refresh(): void;
  /// The owner asked for a Workstation now: asked again if connected,
  /// dialled if not, without waiting out its backoff.
  tryNow(id: string): void;
  /// The live state of each tracked Workstation, by id.
  snapshot(): Record<string, LiveState>;
  /// The connection to a Workstation, while there is one. A visit
  /// invokes and listens over it; the hub keeps asking on it too.
  connectionOf(id: string): Connection | null;
  dispose(): void;
}

interface Tracked {
  record: PairedWorkstation;
  live: LiveState;
  generation: number;
  connection: Connection | null;
  attempt: AbortController | null;
  /// Attempts that failed in a row.
  failures: number;
  connectedAt: number | null;
  /// The next attempt, or the next ask, and when it is due.
  timer: (() => void) | null;
  dueAt: number | null;
  /// When the owner last had it tried now (`tryNow`), or will.
  triedNowAt: number | null;
  /// Refused for good: not tried again until the next Unlock.
  final: boolean;
}

export function createLiveHub(deps: LiveHubDeps): LiveHub {
  const pollMs = deps.pollMs ?? ATTENTION_POLL_MS;
  const policy = deps.reconnect ?? RECONNECT;
  const tryNowGapMs = deps.tryNowGapMs ?? TRY_NOW_GAP_MS;
  const tracked = new Map<string, Tracked>();
  let allowed = false;
  let disposed = false;

  const snapshot = (): Record<string, LiveState> =>
    Object.fromEntries([...tracked].map(([id, t]) => [id, t.live]));

  const changed = (): void => {
    if (!disposed) deps.onChange(snapshot());
  };

  const set = (t: Tracked, live: LiveState): void => {
    t.live = live;
    changed();
  };

  const clearTimer = (t: Tracked): void => {
    t.timer?.();
    t.timer = null;
    t.dueAt = null;
  };

  /// Runs `fn` for `t` in `ms`, unless it has moved on by then.
  const schedule = (t: Tracked, ms: number, fn: (t: Tracked) => void): void => {
    const generation = t.generation;
    t.dueAt = deps.now() + ms;
    t.timer = deps.after(ms, () => {
      t.timer = null;
      t.dueAt = null;
      if (current(t, generation)) fn(t);
    });
  };

  /// Stops everything under way for `t`, and makes the next generation.
  const stop = (t: Tracked, why: string): void => {
    t.generation += 1;
    clearTimer(t);
    t.attempt?.abort();
    t.attempt = null;
    const connection = t.connection;
    t.connection = null;
    t.connectedAt = null;
    if (connection) {
      connection.close(why);
      if (!disposed) deps.onConnection?.(t.record.id, null);
    }
  };

  const current = (t: Tracked, generation: number): boolean =>
    !disposed && allowed && tracked.get(t.record.id) === t && t.generation === generation;

  const retryLater = (t: Tracked): void => {
    if (t.final || !allowed) return;
    t.failures += 1;
    const delay = reconnectDelay(t.failures, policy);
    deps.log?.(`[gavin-hub] ${t.record.id}: trying again in ${delay} ms`);
    schedule(t, delay, (t) => void open(t));
  };

  /// The connection ended, or an ask failed on it: drop it, and try
  /// again.
  const lost = (t: Tracked, problem: string): void => {
    const held = t.connectedAt === null ? 0 : deps.now() - t.connectedAt;
    stop(t, problem);
    if (held >= policy.settledMs) t.failures = 0;
    set(t, { state: "unreachable", problem });
    retryLater(t);
  };

  const ask = async (t: Tracked): Promise<void> => {
    const connection = t.connection;
    if (!connection) return;
    const generation = t.generation;
    let answer: AttentionAnswer;
    try {
      answer = await deps.ask(connection);
    } catch (e) {
      if (current(t, generation)) lost(t, problemOf(e));
      return;
    }
    if (!current(t, generation)) return;
    set(t, answer);
    clearTimer(t);
    schedule(t, pollMs, (t) => void ask(t));
  };

  const open = async (t: Tracked): Promise<void> => {
    stop(t, "Connecting again.");
    const generation = t.generation;
    const attempt = new AbortController();
    t.attempt = attempt;
    set(t, { state: "connecting" });
    const outcome = await deps.connect(t.record, attempt.signal);
    if (!current(t, generation)) {
      if (outcome.outcome === "connected") outcome.connection.close("No longer wanted.");
      return;
    }
    t.attempt = null;
    switch (outcome.outcome) {
      case "connected": {
        const { connection } = outcome;
        t.connection = connection;
        t.connectedAt = deps.now();
        deps.log?.(`[gavin-hub] ${t.record.id}: connected as ${outcome.deviceId}`);
        deps.onConnection?.(t.record.id, connection);
        void connection.closed.then((why) => {
          if (current(t, generation) && t.connection === connection) lost(t, why);
        });
        await ask(t);
        return;
      }
      case "asleep":
        set(t, { state: "asleep" });
        retryLater(t);
        return;
      case "unreachable":
        set(t, { state: "unreachable", problem: outcome.problem });
        retryLater(t);
        return;
      case "refused":
        t.final = refusalIsFinal(outcome.reason);
        set(t, t.final ? { state: "refused", problem: outcome.problem } : { state: "unreachable", problem: outcome.problem });
        retryLater(t);
        return;
      case "failed":
        set(t, { state: "failed", problem: outcome.problem });
        retryLater(t);
        return;
      case "locked":
        set(t, { state: "locked" });
        deps.onNotHeld();
        return;
      case "lapsed":
        set(t, { state: "locked" });
        deps.onLapsed();
        return;
    }
  };

  const connectIdle = (t: Tracked): void => {
    if (t.connection || t.attempt || t.final) return;
    clearTimer(t);
    void open(t);
  };

  const askOrOpen = (t: Tracked): void => {
    if (t.connection) void ask(t);
    else void open(t);
  };

  /// At once, or once `tryNowGapMs` has passed since the owner last asked
  /// -- unless the loop has it due by then anyway. The count of failures
  /// is left as it is.
  const tryNow = (t: Tracked): void => {
    if (!allowed || t.attempt || t.final) return;
    const now = deps.now();
    const at = t.triedNowAt === null ? now : Math.max(now, t.triedNowAt + tryNowGapMs);
    if (t.dueAt !== null && t.dueAt <= at) return;
    t.triedNowAt = at;
    clearTimer(t);
    if (at === now) askOrOpen(t);
    else schedule(t, at - now, askOrOpen);
  };

  return {
    setPaired(records) {
      const ids = new Set(records.map((r) => r.id));
      for (const [id, t] of tracked) {
        if (!ids.has(id)) {
          stop(t, "No longer paired.");
          tracked.delete(id);
        }
      }
      for (const record of records) {
        const known = tracked.get(record.id);
        if (known && known.record.workstationKey === record.workstationKey && known.record.deviceId === record.deviceId) {
          // A rename, or the same record read again.
          known.record = record;
          continue;
        }
        if (known) stop(known, "Paired again.");
        const t: Tracked = {
          record,
          live: { state: "locked" },
          generation: 0,
          connection: null,
          attempt: null,
          failures: 0,
          connectedAt: null,
          timer: null,
          dueAt: null,
          triedNowAt: null,
          final: false,
        };
        tracked.set(record.id, t);
        if (allowed) void open(t);
      }
      changed();
    },

    setAllowed(next) {
      if (next === allowed) {
        if (next) for (const t of tracked.values()) connectIdle(t);
        return;
      }
      allowed = next;
      for (const t of tracked.values()) {
        if (next) {
          // A fresh Unlock: a fresh count, and another try at a
          // Workstation that refused.
          t.failures = 0;
          t.final = false;
          connectIdle(t);
        } else {
          stop(t, "The Companion locked.");
          t.live = { state: "locked" };
        }
      }
      changed();
    },

    refresh() {
      for (const t of tracked.values()) tryNow(t);
    },

    tryNow(id) {
      const t = tracked.get(id);
      if (t) tryNow(t);
    },

    snapshot,

    connectionOf: (id) => tracked.get(id)?.connection ?? null,

    dispose() {
      disposed = true;
      for (const t of tracked.values()) stop(t, "The hub closed.");
      tracked.clear();
    },
  };
}

function problemOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
