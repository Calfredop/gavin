import { describe, it, expect } from "vitest";
import type { Workspace } from "$lib/core/workspace";
import {
  SSH_LIMITATION,
  isSshWorkspace,
  linkFor,
  markConnecting,
  markLost,
  markReady,
  readyHosts,
  seedConnecting,
  sshBadge,
  sshBanner,
  sshLimitation,
  sshRunBlocked,
  sshTabBlocked,
  validateSshInput,
  type SshLinks,
} from "$lib/workspace/sshWorkspace";

function ws(id: string, host?: string, rootPath = "/home/me/repo"): Workspace {
  const base: Workspace = { id, name: id, pages: [], activePageId: null, rootPath };
  return host ? { ...base, ssh: { host } } : base;
}

describe("isSshWorkspace / sshLimitation", () => {
  it("is true only for a workspace with an ssh host", () => {
    expect(isSshWorkspace(ws("far", "box"))).toBe(true);
    expect(isSshWorkspace(ws("near"))).toBe(false);
    expect(isSshWorkspace(null)).toBe(false);
    expect(isSshWorkspace(undefined)).toBe(false);
  });

  it("names the limitation once, for ssh workspaces only", () => {
    expect(sshLimitation(ws("far", "box"))).toBe(SSH_LIMITATION);
    expect(sshLimitation(ws("near"))).toBeNull();
    expect(sshLimitation(null)).toBeNull();
    expect(SSH_LIMITATION).toMatch(/ssh workspaces/);
  });
});

describe("link state reducers", () => {
  it("seeds every ssh host as connecting, without touching a host already known", () => {
    const known: SshLinks = { box: { status: "ready", hostOs: "linux" } };
    const seeded = seedConnecting(known, [ws("a", "box"), ws("b", "nas"), ws("c")]);
    expect(seeded).toEqual({ box: { status: "ready", hostOs: "linux" }, nas: { status: "connecting" } });
  });

  it("ready records the host os and clears an earlier message", () => {
    const lost = markLost({}, "box", "Connection refused");
    expect(lost.box).toEqual({ status: "lost", message: "Connection refused" });
    expect(markReady(lost, "box", "windows").box).toEqual({ status: "ready", hostOs: "windows" });
  });

  it("connecting keeps the host os from before, so a badge does not blink", () => {
    const ready = markReady({}, "box", "linux");
    expect(markConnecting(ready, "box").box).toEqual({ status: "connecting", hostOs: "linux" });
  });

  it("lost without a message is still lost", () => {
    expect(markLost({}, "box", undefined).box).toEqual({ status: "lost" });
  });

  it("readyHosts is the set of hosts a link is up for", () => {
    const links = markLost(markReady(markConnecting({}, "c"), "a", "linux"), "b", "x");
    expect([...readyHosts(links)]).toEqual(["a"]);
  });

  it("ready records the host daemon's version, and the other states carry it", () => {
    const ready = markReady({}, "box", "linux", 39);
    expect(ready.box).toEqual({ status: "ready", hostOs: "linux", daemonVersion: 39 });
    expect(markLost(ready, "box", "gone").box).toEqual({
      status: "lost",
      hostOs: "linux",
      daemonVersion: 39,
      message: "gone",
    });
    expect(markConnecting(ready, "box").box).toEqual({ status: "connecting", hostOs: "linux", daemonVersion: 39 });
    // A ready event with no version leaves an earlier answer standing.
    expect(markReady(ready, "box", null, null).box.daemonVersion).toBe(39);
  });

  it("reducers return new objects and leave the input alone", () => {
    const before: SshLinks = {};
    const after = markConnecting(before, "box");
    expect(before).toEqual({});
    expect(after).not.toBe(before);
  });
});

describe("linkFor / sshBadge / sshBanner", () => {
  const links: SshLinks = {
    up: { status: "ready", hostOs: "linux" },
    down: { status: "lost", message: "ssh: connect to host down port 22: No route to host" },
  };

  it("a local workspace has no link, no badge and no banner", () => {
    expect(linkFor(links, ws("near"))).toBeNull();
    expect(sshBadge(ws("near"), links)).toBeNull();
    expect(sshBanner(ws("near"), links)).toBeNull();
  });

  it("an ssh workspace whose host is unknown yet reads as connecting", () => {
    expect(linkFor(links, ws("new", "elsewhere"))).toEqual({ status: "connecting" });
    expect(sshBadge(ws("new", "elsewhere"), links)).toEqual({
      host: "elsewhere",
      status: "connecting",
      tip: "On elsewhere over ssh — connecting…",
    });
  });

  it("the badge says the host and the state", () => {
    expect(sshBadge(ws("a", "up"), links)).toEqual({
      host: "up",
      status: "ready",
      tip: "On up over ssh (linux)",
    });
    expect(sshBadge(ws("b", "down"), links)?.status).toBe("lost");
    expect(sshBadge(ws("b", "down"), links)?.tip).toContain("No route to host");
  });

  it("the banner speaks only when the link is not up", () => {
    expect(sshBanner(ws("a", "up"), links)).toBeNull();
    expect(sshBanner(ws("b", "down"), links)).toEqual({
      tone: "warning",
      text: "Lost the connection to down — ssh: connect to host down port 22: No route to host",
    });
    expect(sshBanner(ws("c", "elsewhere"), links)).toEqual({
      tone: "muted",
      text: "Connecting to elsewhere over ssh…",
    });
  });
});

describe("sshRunBlocked", () => {
  it("never blocks a local workspace", () => {
    expect(sshRunBlocked(ws("near"), {})).toBeNull();
    expect(sshRunBlocked(null, {})).toBeNull();
  });

  it("blocks while the host is connecting or lost, naming the host", () => {
    expect(sshRunBlocked(ws("a", "box"), {})).toMatch(/Connecting to box/);
    expect(sshRunBlocked(ws("a", "box"), markConnecting({}, "box"))).toMatch(/Connecting to box/);
    expect(sshRunBlocked(ws("a", "box"), markLost({}, "box", "x"))).toMatch(/Not connected to box/);
  });

  it("blocks on a host daemon older than the workspace-file requests, against the HOST's version", () => {
    const old = markReady({}, "box", "linux", 39);
    const blocked = sshRunBlocked(ws("a", "box"), old);
    expect(blocked).toMatch(/v40 on box/);
    expect(blocked).toMatch(/v39/);
    const unknown = markReady({}, "box", "linux");
    expect(sshRunBlocked(ws("a", "box"), unknown)).toMatch(/v40 on box/);
  });

  it("lets a run through once the host's daemon is new enough", () => {
    expect(sshRunBlocked(ws("a", "box"), markReady({}, "box", "linux", 40))).toBeNull();
    expect(sshRunBlocked(ws("a", "box"), markReady({}, "box", "linux", 41))).toBeNull();
  });
});

describe("sshTabBlocked", () => {
  it("never blocks a local workspace, and opens the tabs once the host is v41", () => {
    expect(sshTabBlocked(ws("near"), {})).toBeNull();
    expect(sshTabBlocked(ws("a", "box"), markReady({}, "box", "linux", 41))).toBeNull();
  });

  it("blocks while connecting or lost, and on a host older than v41", () => {
    expect(sshTabBlocked(ws("a", "box"), {})).toMatch(/Connecting to box/);
    expect(sshTabBlocked(ws("a", "box"), markLost({}, "box", "x"))).toMatch(/Not connected to box/);
    // The Git tab needs v41 even though card runs (v40) are fine.
    expect(sshTabBlocked(ws("a", "box"), markReady({}, "box", "linux", 40))).toMatch(/v41 on box/);
  });
});

describe("validateSshInput", () => {
  it("accepts a host, an absolute root and no daemon path", () => {
    expect(validateSshInput({ host: " box ", rootPath: "/home/me/repo/", daemonPath: "" })).toEqual({
      ok: true,
      ssh: { host: "box" },
      rootPath: "/home/me/repo",
    });
  });

  it("keeps a daemon path when given, trimmed", () => {
    const result = validateSshInput({ host: "me@box", rootPath: "/r", daemonPath: " /opt/gavin/gavin-daemon " });
    expect(result).toEqual({ ok: true, ssh: { host: "me@box", daemonPath: "/opt/gavin/gavin-daemon" }, rootPath: "/r" });
  });

  it("turns a Windows path's backslashes into the forward slashes the wire uses", () => {
    const result = validateSshInput({ host: "win", rootPath: "C:\\Users\\me\\repo", daemonPath: "" });
    expect(result).toEqual({ ok: true, ssh: { host: "win" }, rootPath: "C:/Users/me/repo" });
  });

  it("refuses a missing or option-shaped host", () => {
    expect(validateSshInput({ host: "", rootPath: "/r", daemonPath: "" })).toMatchObject({ ok: false });
    expect(validateSshInput({ host: "-oProxyCommand=x", rootPath: "/r", daemonPath: "" })).toMatchObject({ ok: false });
    expect(validateSshInput({ host: "bo x", rootPath: "/r", daemonPath: "" })).toMatchObject({ ok: false });
  });

  it("refuses a relative or empty root", () => {
    expect(validateSshInput({ host: "box", rootPath: "", daemonPath: "" })).toMatchObject({ ok: false });
    expect(validateSshInput({ host: "box", rootPath: "repo", daemonPath: "" })).toMatchObject({ ok: false });
    expect(validateSshInput({ host: "box", rootPath: "~/repo", daemonPath: "" })).toMatchObject({ ok: false });
  });

  it("refuses a daemon path with a double quote, which no host shell can carry", () => {
    const result = validateSshInput({ host: "box", rootPath: "/r", daemonPath: 'C:/a"b/gavin-daemon' });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/double quote/);
  });
});
