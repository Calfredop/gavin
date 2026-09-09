import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import type { AvailableUpdate, UpdateSettings } from "$lib/updates";

const host = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  checkForUpdate: vi.fn(),
}));

vi.mock("$lib/backend", () => host);

import {
  availableUpdate,
  checkingForUpdate,
  lastCheckError,
  lastCheckedAt,
  refreshUpdateChannel,
  runUpdateCheck,
  startUpdateWatch,
  updateChannel,
} from "$lib/updatesState";

const ENDPOINT = "https://example.test/latest.json";

function settings(over: Partial<UpdateSettings> = {}): UpdateSettings {
  return {
    currentVersion: "0.1.0",
    endpoint: ENDPOINT,
    defaultEndpoint: ENDPOINT,
    overridden: false,
    enabled: true,
    pinned: true,
    ...over,
  };
}

const UPDATE: AvailableUpdate = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: null,
  date: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  updateChannel.set(null);
  availableUpdate.set(null);
  lastCheckedAt.set(null);
  lastCheckError.set(null);
  checkingForUpdate.set(false);
});

describe("refreshUpdateChannel", () => {
  it("publishes what the host says", async () => {
    host.updateSettings.mockResolvedValue(settings());
    expect(await refreshUpdateChannel()).toEqual(settings());
    expect(get(updateChannel)).toEqual(settings());
  });

  // An older host with no such command is "not asked yet", not "no
  // channel": the panel draws its neutral state rather than claiming a
  // build has no updater.
  it("leaves the channel null when the host has no such command", async () => {
    host.updateSettings.mockRejectedValue(new Error("unknown command"));
    expect(await refreshUpdateChannel()).toBeNull();
    expect(get(updateChannel)).toBeNull();
  });
});

describe("runUpdateCheck", () => {
  it("publishes an available update", async () => {
    host.updateSettings.mockResolvedValue(settings());
    host.checkForUpdate.mockResolvedValue(UPDATE);
    await runUpdateCheck("launch");
    expect(get(availableUpdate)).toEqual(UPDATE);
    expect(get(lastCheckedAt)).not.toBeNull();
  });

  it("clears a previously available update when the endpoint says current", async () => {
    availableUpdate.set(UPDATE);
    host.updateSettings.mockResolvedValue(settings());
    host.checkForUpdate.mockResolvedValue(null);
    await runUpdateCheck("manual");
    expect(get(availableUpdate)).toBeNull();
  });

  // The whole point of the blocked reasons: a build with nothing to ask
  // makes no request at all, so the launch path costs nothing and the
  // panel's own explanation is the only one on screen.
  it("asks nothing when the build has no endpoint", async () => {
    host.updateSettings.mockResolvedValue(settings({ endpoint: "" }));
    await runUpdateCheck("launch");
    expect(host.checkForUpdate).not.toHaveBeenCalled();
  });

  it("asks nothing when the build pins no key", async () => {
    host.updateSettings.mockResolvedValue(settings({ pinned: false }));
    await runUpdateCheck("manual");
    expect(host.checkForUpdate).not.toHaveBeenCalled();
  });

  it("stays quiet when a launch check fails", async () => {
    host.updateSettings.mockResolvedValue(settings());
    host.checkForUpdate.mockRejectedValue(new Error("404 Not Found"));
    await runUpdateCheck("launch");
    expect(get(lastCheckError)).toBeNull();
  });

  it("reports a failure the human asked for", async () => {
    host.updateSettings.mockResolvedValue(settings());
    host.checkForUpdate.mockRejectedValue(new Error("404 Not Found"));
    await runUpdateCheck("manual");
    expect(get(lastCheckError)).toBe("404 Not Found");
    expect(get(checkingForUpdate)).toBe(false);
  });

  // Token counter, not identity: two checks overlap the moment somebody
  // presses the button while the launch check is still in flight, and
  // the older answer must not land on top of the newer one.
  it("drops a slow answer that a newer check has superseded", async () => {
    host.updateSettings.mockResolvedValue(settings());
    let releaseSlow: (v: AvailableUpdate | null) => void = () => {};
    host.checkForUpdate.mockImplementationOnce(
      () => new Promise((resolve) => (releaseSlow = resolve))
    );
    const slow = runUpdateCheck("launch");

    host.checkForUpdate.mockResolvedValueOnce(UPDATE);
    await runUpdateCheck("manual");
    expect(get(availableUpdate)).toEqual(UPDATE);

    releaseSlow(null);
    await slow;
    expect(get(availableUpdate)).toEqual(UPDATE);
  });
});

describe("startUpdateWatch", () => {
  it("makes exactly one check and no timer", async () => {
    host.updateSettings.mockResolvedValue(settings());
    host.checkForUpdate.mockResolvedValue(null);
    const stop = startUpdateWatch();
    await vi.waitFor(() => expect(host.checkForUpdate).toHaveBeenCalledTimes(1));
    stop();
    // Nothing repeats: the human chose a quiet check, so a second call
    // could only come from a poll this module deliberately does not have.
    await new Promise((r) => setTimeout(r, 20));
    expect(host.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  // A frontend reload re-runs bootstrap, so a check from the previous
  // one can still be in flight. Its teardown bumps the token, which is
  // what stops the old answer writing into the new window's stores.
  it("supersedes a check still in flight from a previous bootstrap", async () => {
    host.updateSettings.mockResolvedValue(settings());
    let releaseSlow: (v: AvailableUpdate | null) => void = () => {};
    host.checkForUpdate.mockImplementationOnce(
      () => new Promise((resolve) => (releaseSlow = resolve))
    );
    const stop = startUpdateWatch();
    await vi.waitFor(() => expect(host.checkForUpdate).toHaveBeenCalledTimes(1));
    stop();

    releaseSlow(UPDATE);
    await new Promise((r) => setTimeout(r, 0));
    expect(get(availableUpdate)).toBeNull();
  });
});
