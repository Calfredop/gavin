import { describe, it, expect } from "vitest";

import { source } from "$lib/sources";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";
import { NO_DEVICES, RELAY_NOTE, STALE_NOTE, TRANSPORT_NOTE } from "$lib/core/remoteAccess";

// The Remote access section is drawn by a component no unit suite can
// mount -- it needs a window, a daemon and a Tauri host -- so what a
// guard can still see is the WIRING: that each control exists, that each
// one reads the version gate, that every call it makes is a real command
// the host registers, and that the copy on screen is the module's rather
// than a second copy written into the markup that would drift from the
// one the tests hold.
//
// The visible surface itself is the owner's to confirm in the running
// app (CLAUDE.md). This is the static pre-flight under it.

const VIEW = source("GlobalSettingsView.svelte");
const MODULE = source("remoteAccess.ts");
const BACKEND = source("backend.ts");

const RUST = import.meta.glob("../../../src-tauri/src/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function rust(file: string): string {
  const found = Object.entries(RUST).find(([path]) => path.endsWith(`/${file}`));
  if (!found) throw new Error(`${file} not found`);
  return found[1];
}

/// The seven `app`-only requests the section drives, as the Tauri
/// command, the backend wrapper, and the daemon request each name them.
const COMMANDS: [command: string, wrapper: string, request: string][] = [
  ["begin_pairing", "beginPairing", "BeginPairing"],
  ["confirm_pairing", "confirmPairing", "ConfirmPairing"],
  ["reject_pairing", "rejectPairing", "RejectPairing"],
  ["list_devices", "listDevices", "ListDevices"],
  ["revoke_device", "revokeDevice", "RevokeDevice"],
  ["revoke_all_devices", "revokeAllDevices", "RevokeAllDevices"],
  ["set_remote_access", "setRemoteAccess", "SetRemoteAccess"],
];

describe("the host side", () => {
  it("registers every command in lib.rs", () => {
    const list = rust("lib.rs").match(/tauri::generate_handler!\[([\s\S]*?)\]/);
    expect(list).not.toBeNull();
    for (const [command] of COMMANDS) {
      expect((list as RegExpMatchArray)[1]).toContain(`session::${command}`);
    }
  });

  it("routes each one through the gated request path", () => {
    const session = rust("session.rs");
    for (const [command, , request] of COMMANDS) {
      const body = session.match(new RegExp(`pub fn ${command}\\(([\\s\\S]*?)\\n\\}`));
      expect(body, `${command} has no body in session.rs`).not.toBeNull();
      const text = (body as RegExpMatchArray)[0];
      // `send_command_reconnecting` is what calls `gate`, which refuses
      // to put a request an older daemon cannot PARSE on the wire -- a
      // parse error there closes the connection and takes every push
      // with it.
      expect(text).toContain("send_command_reconnecting");
      expect(text).toContain(`Request::${request}`);
    }
  });

  // Pairing decides who may reach THIS machine, so the daemon that
  // answers has to be the one the human is sitting at -- never an ssh
  // host's, which is where a `route_for_*` would be able to send it.
  it("aims every one at the local daemon", () => {
    const session = rust("session.rs");
    for (const [command] of COMMANDS) {
      const body = session.match(new RegExp(`pub fn ${command}\\(([\\s\\S]*?)\\n\\}`));
      const text = (body as RegExpMatchArray)[0];
      expect(text).toContain("current_compat(&compat)");
      expect(text).not.toContain("route_for_");
    }
  });

  it("forwards the three device pushes as events", () => {
    const session = rust("session.rs");
    for (const [variant, event] of [
      ["DevicePairingRequested", "device-pairing-requested"],
      ["DeviceConnected", "device-connected"],
      ["DeviceDisconnected", "device-disconnected"],
    ]) {
      expect(session).toContain(`Response::${variant}`);
      expect(session).toContain(`emit("${event}"`);
    }
  });
});

describe("the backend wrappers", () => {
  it("invokes the command each one is named for", () => {
    for (const [command, wrapper] of COMMANDS) {
      expect(BACKEND).toContain(`export function ${wrapper}(`);
      expect(BACKEND).toContain(`invoke("${command}"`);
    }
  });
});

describe("the Settings section", () => {
  it("reaches every one of the seven from the template", () => {
    for (const [, wrapper] of COMMANDS) {
      expect(VIEW, `nothing calls backend.${wrapper}`).toContain(`backend.${wrapper}(`);
    }
  });

  it("listens for the three device events", () => {
    for (const event of ["device-pairing-requested", "device-connected", "device-disconnected"]) {
      expect(VIEW).toContain(`"${event}"`);
    }
  });

  // The section is the ONLY consumer of FEATURE_MIN_VERSION.remoteAccess.
  // Without it the entry the handshake task added is a dead gate
  // (CLAUDE.md), and a human on a v41 daemon presses Pair a device and
  // gets a wire error where a version should have been.
  it("is a featureBlockedReason consumer of the remoteAccess entry", () => {
    expect(MODULE).toContain('featureBlockedReason(compat, "remoteAccess")');
    expect(VIEW).toContain("remoteAccessBlocked($daemonCompat)");
    expect(FEATURE_MIN_VERSION.remoteAccess).toBe(42);
  });

  // Every control, not most of them: one that stays live against an old
  // daemon is the one that produces the error the gate exists to
  // prevent. Counted rather than named, so a control added later without
  // a gate trips this.
  it("greys every control behind that gate", () => {
    const disabled = [...VIEW.matchAll(/disabled=\{([^}]*)\}/g)].map((m) => m[1]);
    const gated = disabled.filter((d) => d.includes("remoteAccessGate !== null"));
    // The toggle, the relay field, Pair a device, Revoke all, and the
    // per-row Revoke.
    expect(gated.length).toBeGreaterThanOrEqual(5);
    // And the section says which version it needs, rather than only
    // going dark.
    expect(VIEW).toContain("{remoteAccessGate}");
  });

  // The reason has to hang on a WRAPPING span: a disabled element fires
  // no mouseenter, so a tooltip on the control itself never opens.
  it("hangs the gate's tooltip on a wrapper, never on the disabled control", () => {
    expect(VIEW).toContain("use:tooltip={remoteAccessGate ?? \"\"}");
    expect(VIEW).not.toMatch(/<input[^>]*use:tooltip=\{remoteAccessGate/);
    expect(VIEW).not.toMatch(/<button[^>]*use:tooltip=\{remoteAccessGate/);
  });

  it("draws the QR inline, from the payload, with no network anywhere", () => {
    expect(VIEW).toContain("qrDraw(pairing.qr)");
    expect(VIEW).toContain("<svg");
    expect(VIEW).toContain("<path d={drawn.path}");
    // No image service, no CDN, no <img>: the thing being drawn is a
    // pairing secret, and a URL is a copy of it leaving the machine.
    expect(VIEW).not.toMatch(/<img[^>]*qr/i);
    expect(MODULE).not.toContain("http://");
    expect(source("qr.ts")).not.toContain("https://");
  });

  it("shows the countdown beside it", () => {
    expect(VIEW).toContain("countdownLabel(pairing.expiresAt, nowMs)");
  });

  // Every prompt's words come from the module, so the copy the unit
  // tests hold is the copy on screen. A title written into the markup
  // would be a second one that drifts.
  it("asks through askConfirm with the module's copy", () => {
    for (const copy of ["pairingConfirmCopy(request)", "revokeDeviceCopy(row)", "revokeAllCopy()"]) {
      expect(VIEW).toContain(`askConfirm(${copy})`);
    }
  });

  it("puts the section's own copy on screen rather than restating it", () => {
    expect(VIEW).toContain("{TRANSPORT_NOTE}");
    expect(VIEW).toContain("{RELAY_NOTE}");
    expect(VIEW).toContain("{NO_DEVICES}");
    // The strings themselves live in the module, not the markup.
    expect(VIEW).not.toContain(TRANSPORT_NOTE);
    expect(VIEW).not.toContain(RELAY_NOTE);
    expect(VIEW).not.toContain(NO_DEVICES);
  });

  it("renders every column the device list promises", () => {
    for (const field of ["row.name", "row.role", "row.pairedAt", "row.lastSeen", "row.note"]) {
      expect(VIEW).toContain(field);
    }
    // Greyed, with §3's own words, rather than hidden.
    expect(VIEW).toContain("class:dimmed={row.dimmed}");
    expect(MODULE).toContain(`"${STALE_NOTE}"`);
  });

  it("is findable by the words a human would type for it", () => {
    const table = VIEW.match(/id: "remote-access",\s*keywords: \[([\s\S]*?)\]/);
    expect(table).not.toBeNull();
    const keywords = (table as RegExpMatchArray)[1];
    for (const word of ["Pair a device", "QR", "Relay URL", "Revoke", "lost phone", "phone"]) {
      expect(keywords).toContain(word);
    }
  });
});
