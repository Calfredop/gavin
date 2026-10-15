import { describe, expect, it } from "vitest";
import { Missed, authorityOf, refreshedAdmission, relayIsDirectPort } from "./paths";

describe("the ways in to a Workstation", () => {
  it("reads host and port from a URL, with the scheme's own port when none is written", () => {
    expect(authorityOf("ws://192.168.68.125:8445")).toBe("192.168.68.125:8445");
    expect(authorityOf("wss://Relay.Example/gavin")).toBe("relay.example:443");
    expect(authorityOf("ws://relay.example")).toBe("relay.example:80");
    expect(authorityOf("wss://[fd7a::5]:8445")).toBe("[fd7a::5]:8445");
    expect(authorityOf("https://relay.example")).toBeNull();
    expect(authorityOf("not a url")).toBeNull();
  });

  it("knows a Relay URL that is one of the direct addresses under another scheme", () => {
    const direct = ["wss://100.79.93.51:8445", "wss://192.168.68.125:8445"];
    expect(relayIsDirectPort("ws://192.168.68.125:8445", direct)).toBe(true);
    expect(relayIsDirectPort("wss://192.168.68.125:8445/", direct)).toBe(true);
    expect(relayIsDirectPort("ws://192.168.68.125:8443", direct)).toBe(false);
    expect(relayIsDirectPort("ws://192.168.68.125:8445", [])).toBe(false);
  });

  it("reads the token out of a RelayAdmissionChanged push and nothing else", () => {
    expect(refreshedAdmission({ type: "RelayAdmissionChanged", token: "t" })).toBe("t");
    expect(refreshedAdmission({ type: "RelayAdmissionChanged", token: "" })).toBeNull();
    expect(refreshedAdmission({ type: "RelayAdmissionChanged" })).toBeNull();
    expect(refreshedAdmission({ type: "DesktopEvent", token: "t" })).toBeNull();
    expect(refreshedAdmission(null)).toBeNull();
  });

  it("says every way that failed, direct addresses nothing answered together", () => {
    const missed = new Missed();
    missed.directUnreachable("wss://100.79.93.51:8445");
    missed.directUnreachable("wss://192.168.68.125:8445");
    missed.say("Its Relay turned the connection away: refused: admission.");
    expect(missed.line()).toBe(
      "Could not reach it directly at wss://100.79.93.51:8445 or wss://192.168.68.125:8445. Is this phone on the same network or tailnet as the Workstation? Its Relay turned the connection away: refused: admission."
    );
  });
});
