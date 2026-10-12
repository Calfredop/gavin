import { describe, it, expect } from "vitest";

import {
  ADMISSION_NOTE,
  DIRECT_NOTE,
  KEEP_RUNNING_NOTE,
  NO_DEVICES,
  PAIRING_IDLE,
  RELAY_NOTE,
  REVOKED_NOTE,
  STALE_NOTE,
  TRANSPORT_NOTE,
  admissionAfterSave,
  admissionPlaceholder,
  admissionToSave,
  countdownLabel,
  deviceRows,
  directAccessBlocked,
  directStatus,
  formatSas,
  knownDevice,
  pairingClosed,
  pairingConfirmCopy,
  pairingConfirmed,
  pairingOffered,
  pairingOpen,
  pairingRejected,
  pairingRequested,
  pairingTick,
  pairingUnavailable,
  qrDraw,
  relayAdmissionBlocked,
  relayStateBlocked,
  relayStatus,
  relayUrlHint,
  relayUrlProblem,
  relayUrlToSave,
  remoteAccessBlocked,
  transportNote,
  revokeAllCopy,
  revokeDeviceCopy,
  secondsLeft,
  type DeviceInfo,
  type DeviceList,
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

  // A pairing for an id the row already has replaces that row's keys.
  it("says when the pairing is for a device the desk already trusts", () => {
    const row: DeviceInfo = {
      deviceId: "dev-1",
      name: "Alex's old name",
      role: "remote",
      createdAt: 1,
      lastSeenAt: 2,
      revokedAt: null,
      stale: false,
    };
    const list = { devices: [row], remoteAccessEnabled: true } as DeviceList;
    const known = knownDevice(REQUEST, list);
    expect(known).toBe(row);

    const text = pairingConfirmCopy(REQUEST, known).lines.join(" ");
    expect(text).toContain("already trusts");
    expect(text).toContain("REPLACES");
    expect(text).toContain("Alex's old name");

    // A Device the desk has not met gets no such line.
    expect(knownDevice({ ...REQUEST, deviceId: "dev-2" }, list)).toBeNull();
    expect(knownDevice(REQUEST, null)).toBeNull();
    expect(pairingConfirmCopy(REQUEST).lines.join(" ")).not.toContain("already trusts");
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
  // What the switch does, in the daemon's own terms. Since the daemon
  // dials, the three things a human would want to know before turning
  // it on are whether anything is opened on this machine (no), whether
  // it keeps going with the window closed (yes), and what off means
  // (nothing is dialled).
  it("says the daemon dials out, opens no port, and dials nothing when off", () => {
    expect(TRANSPORT_NOTE).toContain("dials the Relay");
    expect(TRANSPORT_NOTE).toContain("opens no port");
    expect(TRANSPORT_NOTE).toContain("window open or closed");
    expect(TRANSPORT_NOTE).toContain("Off, it dials nothing");
    // The claim the section used to make, and must not make any more.
    expect(TRANSPORT_NOTE).not.toContain("no transport");
    expect(TRANSPORT_NOTE).not.toContain("nothing dials");
  });

  // Keep-running mode: the switch now changes what the red button does,
  // and the section is the only place that can say so before it happens.
  it("says closing keeps gavin in the menu bar and the Mac awake for a running agent", () => {
    expect(KEEP_RUNNING_NOTE).toContain("menu bar");
    expect(KEEP_RUNNING_NOTE).toContain("Quit");
    expect(KEEP_RUNNING_NOTE).toContain("idle-sleep while an agent is running");
  });

  it("says the Relay cannot read what it carries", () => {
    expect(TRANSPORT_NOTE).toContain("cannot read");
  });

  it("says the relay URL rides in the QR and what an empty one means", () => {
    expect(RELAY_NOTE).toContain("pairing QR");
    expect(RELAY_NOTE).toContain("Empty");
    expect(RELAY_NOTE).toContain("wss://");
  });

  it("says where the admission token comes from and where it goes", () => {
    expect(ADMISSION_NOTE).toContain("whoever runs the Relay");
    expect(ADMISSION_NOTE).toContain("pairing QR");
    // It is write-only on this screen, and the human should know that
    // before they go looking for it.
    expect(ADMISSION_NOTE).toContain("not shown again");
    // And that it goes when the Relay does, before they find the field
    // empty and take it for a fault.
    expect(ADMISSION_NOTE).toContain("Changing the Relay URL forgets it");
  });

  // The note describes what the DAEMON does, so it has to be about the
  // daemon that is running. One older than v52 has the switch and the
  // URL and dials nothing: under the ordinary note a human would turn
  // remote access on, see nothing wrong, and wait for a Device that
  // cannot arrive.
  describe("against a daemon that does not dial", () => {
    const needed = FEATURE_MIN_VERSION.relayDial;
    const old = { daemonVersion: needed - 1, appVersion: needed, degraded: true };
    const current = { daemonVersion: needed, appVersion: needed, degraded: false };

    it("is gated at the version that started dialling", () => {
      expect(needed).toBe(52);
    });

    it("says the running daemon dials nothing, and what to do about it", () => {
      const note = transportNote(old);
      expect(note).not.toBe(TRANSPORT_NOTE);
      expect(note).toContain("dials nothing");
      expect(note).toContain(`v${needed}`);
      expect(note).toContain("Restart the daemon");
      expect(note).not.toContain("stays connected");
    });

    it("says the ordinary thing to a daemon that does, and before one has answered", () => {
      expect(transportNote(current)).toBe(TRANSPORT_NOTE);
      expect(transportNote(null)).toBe(TRANSPORT_NOTE);
    });
  });
});

describe("the relay URL", () => {
  it("trims, and reads an empty field as no relay", () => {
    expect(relayUrlToSave("  wss://relay.example  ")).toBe("wss://relay.example");
    expect(relayUrlToSave("")).toBeNull();
    expect(relayUrlToSave("   ")).toBeNull();
  });

  // A hint, never a refusal to SAVE: the daemon keeps the string as
  // typed. But the daemon does have an opinion about what it will DIAL
  // (`protocol::relay::RelayUrl`), and a URL it will not dial is one the
  // human has to be told about here -- the daemon's only other way of
  // saying so is a line in its log.
  it("hints at a missing scheme without refusing the value", () => {
    expect(relayUrlHint("relay.example")).toMatch(/wss:\/\//);
    expect(relayUrlHint("wss://relay.example")).toBeNull();
    expect(relayUrlHint("")).toBeNull();
    expect(relayUrlToSave("relay.example")).toBe("relay.example");
  });

  it("is silent about every URL the daemon will dial", () => {
    for (const url of [
      "wss://relay.example/gavin",
      "  wss://relay.example/gavin  ",
      "WSS://relay.example:8443",
      "ws://127.0.0.1:9000",
      "ws://localhost:9000/relay",
      "ws://192.168.1.20:9000",
      "ws://10.0.0.4",
      "ws://172.20.1.1:1",
      "ws://100.100.4.2:9000",
      "ws://[::1]:9000",
      "ws://[fe80::1]",
      "ws://[fd12:3456::1]:9000",
      "ws://studio.local:9000",
      "wss://relay.example/@gavin",
    ]) {
      expect(relayUrlHint(url), url).toBeNull();
    }
  });

  it("says a plain URL to a public host will not be dialled, and what to type", () => {
    for (const url of ["ws://relay.example/gavin", "ws://8.8.8.8:9000", "ws://[2001:db8::1]:9000"]) {
      const hint = relayUrlHint(url);
      expect(hint, url).toContain("unencrypted");
      expect(hint, url).toContain("wss://");
    }
  });

  it("names what is wrong with a URL the daemon cannot read", () => {
    expect(relayUrlHint("https://relay.example")).toContain("not https://");
    expect(relayUrlHint("wss://")).toContain("no host");
    expect(relayUrlHint("wss:///path")).toContain("no host");
    expect(relayUrlHint("wss://relay.example:0")).toContain("port");
    expect(relayUrlHint("wss://relay.example:99999")).toContain("port");
    expect(relayUrlHint("wss://relay.example:abc")).toContain("port");
    expect(relayUrlHint("wss://[::1")).toContain("no host");
    expect(relayUrlHint("wss://token@relay.example")).toContain("admission token");
    expect(relayUrlHint("wss://relay_one.example")).toContain("not a host name");
  });

  // Every one of these says the same thing last: the value was kept,
  // and the daemon will not act on it.
  it("says the value was saved and will not be dialled", () => {
    for (const url of ["relay.example", "https://relay.example", "ws://relay.example"]) {
      expect(relayUrlHint(url), url).toContain("will not dial");
    }
  });

  // `relayUrlProblem` is a second implementation of a rule that lives
  // in Rust (`protocol::relay::RelayUrl::parse`), and a mirror is only a
  // mirror while something holds it to the original. This is that: one
  // table, in `test-fixtures/relay-urls/`, asserted here and in the
  // protocol crate's own suite. A disagreement between the two is a
  // hint that says "the daemon will not dial it" about a URL the daemon
  // is dialling, or says nothing about one it refuses.
  describe("against the table it shares with the daemon", () => {
    interface Case {
      url: string;
      dial?: { secure: boolean; host: string; port: number; local: boolean };
      refuse?: string;
    }
    const raw = Object.values(
      import.meta.glob("../../../../test-fixtures/relay-urls/cases.json", {
        query: "?raw",
        import: "default",
        eager: true,
      }) as Record<string, string>
    )[0];
    const cases = JSON.parse(raw) as Case[];

    it("has the table", () => {
      expect(cases.length).toBeGreaterThan(90);
      for (const c of cases) {
        expect(Number(c.dial !== undefined) + Number(c.refuse !== undefined), c.url).toBe(1);
      }
    });

    it("is silent about every URL the daemon will dial", () => {
      for (const c of cases.filter((c) => c.dial !== undefined)) {
        expect(relayUrlProblem(c.url), JSON.stringify(c.url)).toBeNull();
        expect(relayUrlHint(c.url), JSON.stringify(c.url)).toBeNull();
      }
    });

    it("names the daemon's own reason for every URL it refuses", () => {
      const seen = new Set<string>();
      for (const c of cases.filter((c) => c.refuse !== undefined)) {
        const problem = relayUrlProblem(c.url);
        expect(problem?.kind, JSON.stringify(c.url)).toBe(c.refuse);
        seen.add(c.refuse as string);
      }
      // Every refusal there is has a case.
      expect([...seen].sort()).toEqual([
        "credentials",
        "host",
        "no-host",
        "no-scheme",
        "plain-to-public-host",
        "port",
        "scheme",
      ]);
    });

    // The one refusal with no hint: an empty field is not a mistake, it
    // is no Relay.
    it("hints at every refusal but an empty field", () => {
      for (const c of cases.filter((c) => c.refuse !== undefined)) {
        if (c.url.trim() === "") expect(relayUrlHint(c.url)).toBeNull();
        else expect(relayUrlHint(c.url), JSON.stringify(c.url)).toContain("will not dial");
      }
    });
  });
});

describe("the admission token", () => {
  // The field is write-only: it starts empty whether or not a token is
  // stored. So an empty field cannot mean "clear it" -- leaving the
  // field alone would wipe the token every time the switch was toggled.
  it("sends nothing for an empty field, which leaves the stored token alone", () => {
    expect(admissionToSave("")).toBeUndefined();
    expect(admissionToSave("   ")).toBeUndefined();
  });

  it("sends a typed token trimmed", () => {
    expect(admissionToSave("  let-me-in\n")).toBe("let-me-in");
  });

  // What the daemon will hold after a save, so the field can say so at
  // once instead of after the next read. The daemon's rule, mirrored: a
  // token goes with the Relay it was given for.
  describe("what is stored after a save", () => {
    const stored = { relayUrl: "wss://relay.example", relayAdmissionSet: true };

    it("is the token that was sent", () => {
      expect(admissionAfterSave(stored, "wss://relay.example", "new")).toBe(true);
      expect(admissionAfterSave({ ...stored, relayAdmissionSet: false }, null, "new")).toBe(true);
    });

    it("is nothing, when it was cleared", () => {
      expect(admissionAfterSave(stored, "wss://relay.example", "")).toBe(false);
    });

    it("is what it was, when nothing was sent and the Relay is the same", () => {
      expect(admissionAfterSave(stored, "wss://relay.example", undefined)).toBe(true);
      expect(
        admissionAfterSave({ ...stored, relayAdmissionSet: false }, "wss://relay.example", undefined)
      ).toBe(false);
    });

    it("is nothing, when nothing was sent and the Relay changed", () => {
      expect(admissionAfterSave(stored, "wss://other.example", undefined)).toBe(false);
      expect(admissionAfterSave(stored, null, undefined)).toBe(false);
    });
  });

  it("says whether one is stored, since it cannot show it", () => {
    expect(admissionPlaceholder(true)).toContain("stored");
    expect(admissionPlaceholder(true)).toContain("replace");
    expect(admissionPlaceholder(false)).toContain("No token");
  });

  it("is gated on the daemon that keeps it", () => {
    const needed = FEATURE_MIN_VERSION.relayAdmission;
    expect(needed).toBe(52);
    const reason = relayAdmissionBlocked({
      daemonVersion: needed - 1,
      appVersion: needed,
      degraded: true,
    });
    expect(reason).toContain(`v${needed}`);
    expect(reason).toContain("Restart the daemon");
    expect(
      relayAdmissionBlocked({ daemonVersion: needed, appVersion: needed, degraded: false })
    ).toBeNull();
    expect(relayAdmissionBlocked(null)).toBeNull();
  });
});

describe("whether a Device can pair at all", () => {
  const list = (over: Partial<DeviceList>): DeviceList => ({
    devices: [],
    remoteAccessEnabled: true,
    relayUrl: "wss://relay.example/gavin",
    relayAdmissionSet: true,
    ...over,
  });

  const needed = FEATURE_MIN_VERSION.relayDial;
  const dials = { daemonVersion: needed, appVersion: needed, degraded: false };

  it("can, with remote access on and a Relay the daemon will dial", () => {
    expect(pairingUnavailable(list({}), dials)).toBeNull();
    // A Relay that asks for no token is the Relay's business.
    expect(pairingUnavailable(list({ relayAdmissionSet: false }), dials)).toBeNull();
    // Before the daemon has said which it is, the settings decide.
    expect(pairingUnavailable(list({}), null)).toBeNull();
  });

  // A daemon older than v52 draws a QR and dials nothing: the Device
  // that scans it is told the Workstation is not there.
  it("cannot against a daemon that does not dial, and names the version", () => {
    const reason = pairingUnavailable(list({}), {
      daemonVersion: needed - 1,
      appVersion: needed,
      degraded: true,
    });
    expect(reason).toContain(`v${needed}`);
    expect(reason).toContain("Restart the daemon");
  });

  // A QR drawn now would point a Device at a Relay the daemon is not
  // connected to: the Device would scan it and be told the Workstation
  // is not there.
  it("cannot with remote access off, and says to turn it on", () => {
    expect(pairingUnavailable(list({ remoteAccessEnabled: false }), dials)).toContain(
      "Turn remote access on"
    );
  });

  it("cannot with no Relay, and says to name one", () => {
    expect(pairingUnavailable(list({ relayUrl: null }), dials)).toContain("Relay URL");
  });

  it("cannot with a Relay the daemon will not dial", () => {
    expect(pairingUnavailable(list({ relayUrl: "ws://relay.example" }), dials)).toContain(
      "will not dial"
    );
  });

  // Unknown is not unavailable: before the list has been read there is
  // nothing to say, and the version gate is what greys the button then.
  it("has no opinion before the settings have been read", () => {
    expect(pairingUnavailable(null, dials)).toBeNull();
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

describe("whether the daemon reached its Relay", () => {
  const NOW = 1_800_000_000_000;
  const list: DeviceList = {
    devices: [],
    remoteAccessEnabled: true,
    relayUrl: "wss://relay.example/gavin",
    relayAdmissionSet: true,
  };
  const needed = FEATURE_MIN_VERSION.relayState;
  const knows = { daemonVersion: needed, appVersion: needed, degraded: false };

  it("says nothing before the daemon has been asked, and about a state it does not know", () => {
    expect(relayStatus(null, NOW).badge).toBeNull();
    expect(relayStatus({ state: "unknown" }, NOW).badge).toBeNull();
  });

  it("names each of the four states", () => {
    expect(relayStatus({ state: "not_wanted" }, NOW)).toMatchObject({
      badge: "not_wanted",
      text: "Not connected",
    });
    expect(relayStatus({ state: "dialling" }, NOW)).toMatchObject({ badge: "dialling" });
    const connected = relayStatus({ state: "connected", since: NOW / 1000 - 300 }, NOW);
    expect(connected).toMatchObject({ badge: "connected", text: "Connected" });
    expect(connected.detail).toBe("Connected 5m ago.");
  });

  it("gives a failure in the daemon's own words", () => {
    const failed = relayStatus(
      { state: "failed", why: "the Relay did not accept the admission token" },
      NOW
    );
    expect(failed.badge).toBe("failed");
    expect(failed.detail).toContain("the Relay did not accept the admission token");
  });

  it("offers pairing only while connected", () => {
    expect(pairingUnavailable(list, knows, { state: "connected", since: 1 })).toBeNull();
    expect(pairingUnavailable(list, knows, { state: "dialling" })).toContain("still connecting");
    expect(
      pairingUnavailable(list, knows, { state: "failed", why: "could not reach the Relay" })
    ).toContain("could not reach the Relay");
    expect(pairingUnavailable(list, knows, { state: "not_wanted" })).not.toBeNull();
  });

  // Unknown is not unavailable, and a daemon too old to be asked cannot
  // be blamed for its silence.
  it("does not refuse pairing on a state it has not read or cannot ask for", () => {
    expect(pairingUnavailable(list, knows, null)).toBeNull();
    expect(pairingUnavailable(list, knows, { state: "unknown" })).toBeNull();
    const old = { daemonVersion: needed - 1, appVersion: needed, degraded: true };
    expect(pairingUnavailable(list, old, { state: "failed", why: "x" })).toBeNull();
  });

  it("is gated by the version that can answer, and names it", () => {
    expect(relayStateBlocked(null)).toBeNull();
    expect(relayStateBlocked(knows)).toBeNull();
    const reason = relayStateBlocked({ daemonVersion: needed - 1, appVersion: needed, degraded: true });
    expect(reason).toContain(`v${needed}`);
  });
});

describe("the direct listener (ADR 0009)", () => {
  const needed = FEATURE_MIN_VERSION.directAccess;
  const knows = { daemonVersion: needed, appVersion: needed, degraded: false };
  const listening = { state: "listening" as const, port: 8445, addresses: ["wss://100.79.93.51:8445"] };
  const noRelay: DeviceList = {
    devices: [],
    remoteAccessEnabled: true,
    relayUrl: null,
    relayAdmissionSet: false,
    directAccessEnabled: true,
  };

  it("is gated at v69, and names the version against an older daemon", () => {
    expect(needed).toBe(69);
    expect(directAccessBlocked(null)).toBeNull();
    expect(directAccessBlocked(knows)).toBeNull();
    const reason = directAccessBlocked({ daemonVersion: needed - 1, appVersion: needed, degraded: true });
    expect(reason).toContain(`v${needed}`);
  });

  it("says where a phone paired now will look", () => {
    expect(directStatus(null).badge).toBeNull();
    expect(directStatus({ state: "unknown" }).badge).toBeNull();
    expect(directStatus({ state: "not_wanted" })).toMatchObject({ badge: "not_wanted", text: "Not listening" });
    const line = directStatus(listening);
    expect(line).toMatchObject({ badge: "listening", text: "Listening on port 8445" });
    expect(line.detail).toContain("wss://100.79.93.51:8445");
    expect(directStatus({ ...listening, addresses: [] }).detail).toContain("nowhere to reach it directly");
    const failed = directStatus({ state: "failed", why: "could not listen on port 8445: Address already in use" });
    expect(failed.badge).toBe("failed");
    expect(failed.detail).toContain("Address already in use");
  });

  it("lets a listening Workstation pair with no Relay set", () => {
    expect(pairingUnavailable(noRelay, knows, null, listening)).toBeNull();
    // Not listening, or nothing to give the phone: the Relay rules apply.
    expect(pairingUnavailable(noRelay, knows, null, { state: "not_wanted" })).toContain("Relay URL");
    expect(pairingUnavailable(noRelay, knows, null, { ...listening, addresses: [] })).toContain("Relay URL");
    expect(pairingUnavailable(noRelay, knows, null, null)).toContain("Relay URL");
    // Remote access off is still off.
    expect(pairingUnavailable({ ...noRelay, remoteAccessEnabled: false }, knows, null, listening)).toContain(
      "Turn remote access on"
    );
    // A Relay that is down does not stop a listener that is up.
    const relayDown = { ...noRelay, relayUrl: "wss://relay.example" };
    expect(pairingUnavailable(relayDown, knows, { state: "failed", why: "no" }, listening)).toBeNull();
  });

  it("says the phone needs to be on the same network or tailnet, and to pair again", () => {
    expect(DIRECT_NOTE).toContain("tailnet");
    expect(DIRECT_NOTE).toContain("Pair again");
  });
});
