import { describe, it, expect } from "vitest";

import {
  NO_DEVICES,
  PAIRING_IDLE,
  RELAY_NOTE,
  REVOKED_NOTE,
  STALE_NOTE,
  TRANSPORT_NOTE,
  countdownLabel,
  deviceRows,
  formatSas,
  pairingClosed,
  pairingConfirmCopy,
  pairingConfirmed,
  pairingOffered,
  pairingOpen,
  pairingRejected,
  pairingRequested,
  pairingTick,
  qrDraw,
  relayUrlHint,
  relayUrlToSave,
  remoteAccessBlocked,
  revokeAllCopy,
  revokeDeviceCopy,
  secondsLeft,
  type DeviceInfo,
  type PairingRequest,
  type PairingState,
} from "$lib/core/remoteAccess";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);

const REQUEST: PairingRequest = { deviceId: "dev-1", name: "Alex's iPhone", sas: "482913" };

function offer(secondsAhead = 120): PairingState {
  return pairingOffered({ qr: '{"rendezvous":[]}', expiresAt: NOW_S + secondsAhead });
}

describe("the pairing state machine", () => {
  it("starts idle and opens on an offer", () => {
    expect(PAIRING_IDLE.phase).toBe("idle");
    expect(pairingOpen(PAIRING_IDLE)).toBe(false);
    const state = offer();
    expect(state).toMatchObject({ phase: "offer", expiresAt: NOW_S + 120 });
    expect(pairingOpen(state)).toBe(true);
  });

  it("goes offer -> requested when a phone finishes the handshake", () => {
    const state = pairingRequested(offer(), REQUEST);
    expect(state.phase).toBe("requested");
    expect(state).toMatchObject({ request: REQUEST });
  });

  it("carries the QR through so the panel does not blank mid-ceremony", () => {
    const requested = pairingRequested(offer(), REQUEST);
    expect(requested).toMatchObject({ qr: '{"rendezvous":[]}', expiresAt: NOW_S + 120 });
  });

  it("goes requested -> confirmed", () => {
    const state = pairingConfirmed(pairingRequested(offer(), REQUEST));
    expect(state).toEqual({ phase: "confirmed", request: REQUEST });
  });

  it("goes requested -> rejected", () => {
    const state = pairingRejected(pairingRequested(offer(), REQUEST));
    expect(state).toEqual({ phase: "rejected", request: REQUEST });
  });

  it("goes offer -> expired once the two minutes are up", () => {
    const state = offer(120);
    expect(pairingTick(state, NOW)).toBe(state);
    expect(pairingTick(state, NOW + 119_000)).toBe(state);
    expect(pairingTick(state, NOW + 120_000)).toEqual({ phase: "expired" });
  });

  // The window gates when a handshake may START. A phone that has
  // already finished one has spent the secret; cutting the human off
  // mid-comparison would throw away a completed ceremony.
  it("does not expire a request the human is already comparing", () => {
    const requested = pairingRequested(offer(1), REQUEST);
    expect(pairingTick(requested, NOW + 600_000)).toBe(requested);
  });

  // A second phone racing the first must not swap the digits out from
  // under the human -- that is exactly how a code nobody compared gets
  // confirmed.
  it("ignores a second request while one is unanswered", () => {
    const first = pairingRequested(offer(), REQUEST);
    const other: PairingRequest = { deviceId: "dev-2", name: "Unknown", sas: "000000" };
    expect(pairingRequested(first, other)).toBe(first);
  });

  it("ignores a request with no offer on screen", () => {
    expect(pairingRequested(PAIRING_IDLE, REQUEST)).toBe(PAIRING_IDLE);
    expect(pairingRequested({ phase: "expired" }, REQUEST)).toEqual({ phase: "expired" });
  });

  it("refuses to settle a ceremony that never got a request", () => {
    const o = offer();
    expect(pairingConfirmed(o)).toBe(o);
    expect(pairingRejected(o)).toBe(o);
    expect(pairingConfirmed(PAIRING_IDLE)).toBe(PAIRING_IDLE);
  });

  // Pressing "Pair a device" again starts over from any phase, which is
  // what the daemon does with the old offer and any handshake on it.
  it("restarts from any phase", () => {
    for (const state of [
      PAIRING_IDLE,
      offer(),
      pairingRequested(offer(), REQUEST),
      pairingConfirmed(pairingRequested(offer(), REQUEST)),
      { phase: "expired" } as PairingState,
    ]) {
      void state;
      expect(pairingOffered({ qr: "x", expiresAt: 1 })).toEqual({
        phase: "offer",
        qr: "x",
        expiresAt: 1,
      });
    }
    expect(pairingClosed()).toEqual(PAIRING_IDLE);
  });
});

describe("the countdown", () => {
  it("counts down from the daemon's absolute stamp", () => {
    expect(secondsLeft(NOW_S + 120, NOW)).toBe(120);
    expect(countdownLabel(NOW_S + 120, NOW)).toBe("2:00");
    expect(countdownLabel(NOW_S + 119, NOW)).toBe("1:59");
    expect(countdownLabel(NOW_S + 5, NOW)).toBe("0:05");
  });

  // A panel left open across a suspend has to show the truth when the
  // screen comes back, not a timer that paused with the process.
  it("never goes negative, and says so", () => {
    expect(secondsLeft(NOW_S - 600, NOW)).toBe(0);
    expect(countdownLabel(NOW_S - 600, NOW)).toBe("expired");
    expect(countdownLabel(NOW_S, NOW)).toBe("expired");
  });
});

describe("the SAS", () => {
  it("splits six digits into two groups of three", () => {
    expect(formatSas("482913")).toBe("482 913");
  });

  // A daemon that ever widened the SAS must not have it silently
  // reformatted into something that is not what it sent.
  it("leaves anything that is not six digits alone", () => {
    expect(formatSas("4829")).toBe("4829");
    expect(formatSas("48291a")).toBe("48291a");
  });
});

describe("the QR", () => {
  it("draws a path for a real pairing payload", () => {
    const payload = JSON.stringify({
      daemonPublicKey: "a".repeat(64),
      secret: "b".repeat(64),
      rendezvous: ["wss://relay.example/gavin"],
      protocolVersion: FEATURE_MIN_VERSION.remoteAccess,
    });
    const drawn = qrDraw(payload);
    expect(drawn.error).toBeNull();
    expect(drawn.size).toBeGreaterThan(21);
    expect(drawn.path.startsWith("M")).toBe(true);
  });

  // A blank square where a QR should be is a panel that looks broken and
  // says nothing.
  it("reports why there is nothing to draw rather than drawing nothing", () => {
    const drawn = qrDraw("x".repeat(4000));
    expect(drawn.path).toBe("");
    expect(drawn.error).toMatch(/too much for a QR code/);
  });
});

describe("the device list", () => {
  const base: DeviceInfo = {
    deviceId: "dev-1",
    name: "Alex's iPhone",
    role: "remote",
    createdAt: NOW_S - 30 * 24 * 3600,
    lastSeenAt: NOW_S - 2 * 24 * 3600,
    revokedAt: null,
    stale: false,
  };

  it("renders name, role and both ages", () => {
    const [row] = deviceRows([base], NOW);
    expect(row).toMatchObject({
      deviceId: "dev-1",
      name: "Alex's iPhone",
      role: "remote",
      pairedAt: "4w ago",
      lastSeen: "2d ago",
      dimmed: false,
      note: null,
      revocable: true,
    });
    expect(row.lastSeenTitle).toContain(String(new Date(base.lastSeenAt * 1000).getFullYear()));
  });

  // §3: a device unseen for ninety days is greyed with "re-pair to use"
  // and refused until it pairs again. The flag is the DAEMON's -- the app
  // never re-derives it from last_seen_at, because the row it greys has
  // to be the row the daemon will actually refuse.
  it("greys a stale device with the spec's words", () => {
    const [row] = deviceRows([{ ...base, stale: true }], NOW);
    expect(row.dimmed).toBe(true);
    expect(row.note).toBe(STALE_NOTE);
    expect(STALE_NOTE).toBe("re-pair to use");
    // Still revocable: a device the daemon refuses is still a row in the
    // trust store, and the human may want it gone rather than nagging.
    expect(row.revocable).toBe(true);
  });

  it("greys a revoked device and disables its Revoke", () => {
    const [row] = deviceRows([{ ...base, revokedAt: NOW_S - 3600 }], NOW);
    expect(row.dimmed).toBe(true);
    expect(row.note).toBe(REVOKED_NOTE);
    expect(row.revocable).toBe(false);
  });

  it("puts revoked rows last and the most recently seen first", () => {
    const rows = deviceRows(
      [
        { ...base, deviceId: "old", lastSeenAt: NOW_S - 40 * 24 * 3600 },
        { ...base, deviceId: "gone", revokedAt: NOW_S - 10, lastSeenAt: NOW_S },
        { ...base, deviceId: "fresh", lastSeenAt: NOW_S - 60 },
      ],
      NOW
    );
    expect(rows.map((r) => r.deviceId)).toEqual(["fresh", "old", "gone"]);
  });

  it("does not reorder the caller's array", () => {
    const devices = [
      { ...base, deviceId: "a", revokedAt: NOW_S },
      { ...base, deviceId: "b" },
    ];
    deviceRows(devices, NOW);
    expect(devices.map((d) => d.deviceId)).toEqual(["a", "b"]);
  });

  it("says what an empty list means", () => {
    expect(deviceRows([], NOW)).toEqual([]);
    expect(NO_DEVICES).toContain("Pair a device");
  });
});

describe("the prompts", () => {
  it("shows the six digits and names both buttons", () => {
    const copy = pairingConfirmCopy(REQUEST);
    expect(copy.title).toContain("Alex's iPhone");
    expect(copy.lines.join(" ")).toContain("482 913");
    expect(copy.confirmLabel).toBe("Pair this device");
    expect(copy.cancelLabel).toBe("Reject");
    expect(copy.confirmLabel).not.toBe("OK");
  });

  // `danger` is what keeps focus on the dismissing button, so Enter
  // cannot confirm a code nobody compared.
  it("keeps focus off the confirm button", () => {
    expect(pairingConfirmCopy(REQUEST).danger).toBe(true);
    expect(revokeDeviceCopy({ name: "x" }).danger).toBe(true);
    expect(revokeAllCopy().danger).toBe(true);
  });

  // §3: "On loss: Revoke all devices is the one-button answer, and the
  // pairing screen says so."
  it("points a lost phone at Revoke all from the pairing prompt", () => {
    expect(pairingConfirmCopy(REQUEST).lines.join(" ")).toContain("Revoke all devices");
  });

  it("says a revoke reaches a live connection", () => {
    const copy = revokeDeviceCopy({ name: "Alex's iPhone" });
    expect(copy.title).toContain("Alex's iPhone");
    expect(copy.lines.join(" ")).toContain("drops any connection");
    expect(copy.confirmLabel).toBe("Revoke device");
  });

  // The whole reason "Revoke all" is not just "revoke each": it rotates
  // the key, which is what survives a restored backup.
  it("says Revoke all rotates the key and forces every phone to re-pair", () => {
    const copy = revokeAllCopy();
    const text = copy.lines.join(" ");
    expect(text).toContain("rotated");
    expect(text).toContain("pair again");
    expect(copy.confirmLabel).toContain("rotate the key");
  });
});

describe("the section's copy", () => {
  // The card's own requirement, and §10's "must not": remote access on,
  // with no transport, is a store with rows in it and nothing to serve.
  it("says nothing listens and nothing dials", () => {
    expect(TRANSPORT_NOTE).toContain("Nothing listens and nothing dials");
    expect(TRANSPORT_NOTE).toContain("does not exist yet");
    // And says what IS real, so the switch does not read as decorative.
    expect(TRANSPORT_NOTE).toContain("trust store");
  });

  it("says the relay URL is stored as typed and rides in the QR", () => {
    expect(RELAY_NOTE).toContain("LAN only");
    expect(RELAY_NOTE).toContain("exactly as typed");
  });
});

describe("the relay URL", () => {
  it("trims, and reads an empty field as no relay", () => {
    expect(relayUrlToSave("  wss://relay.example  ")).toBe("wss://relay.example");
    expect(relayUrlToSave("")).toBeNull();
    expect(relayUrlToSave("   ")).toBeNull();
  });

  // A hint, never a refusal: the daemon keeps the string raw and has no
  // opinion about whose relay it is.
  it("hints at a missing scheme without refusing the value", () => {
    expect(relayUrlHint("relay.example")).toMatch(/wss:\/\//);
    expect(relayUrlHint("wss://relay.example")).toBeNull();
    expect(relayUrlHint("")).toBeNull();
    expect(relayUrlToSave("relay.example")).toBe("relay.example");
  });
});

describe("the gate", () => {
  it("names the daemon version the section needs", () => {
    const needed = FEATURE_MIN_VERSION.remoteAccess;
    const reason = remoteAccessBlocked({
      daemonVersion: needed - 1,
      appVersion: needed,
      degraded: true,
    });
    expect(reason).toContain(`v${needed}`);
    expect(reason).toContain(`v${needed - 1}`);
    expect(reason).toContain("Restart the daemon");
  });

  it("is silent on a daemon new enough, and before the app has connected", () => {
    const needed = FEATURE_MIN_VERSION.remoteAccess;
    expect(
      remoteAccessBlocked({ daemonVersion: needed, appVersion: needed, degraded: false })
    ).toBeNull();
    expect(remoteAccessBlocked(null)).toBeNull();
  });
});
