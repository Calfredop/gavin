import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/backend", () => ({ prStatus: vi.fn() }));

import * as backend from "$lib/backend";
import {
  __interestKeys,
  __resetForTesting,
  prPollingRunning,
  prReportFor,
  prReports,
  refreshPr,
  requestPr,
  startPrPolling,
} from "$lib/git/prState";
import { prKey } from "$lib/git/pullRequest";
import type { PrReport } from "$lib/git/pullRequest";

const NONE: PrReport = { state: "none" };

beforeEach(() => {
  __resetForTesting();
  vi.mocked(backend.prStatus).mockReset();
  vi.mocked(backend.prStatus).mockResolvedValue(NONE);
});

afterEach(() => {
  __resetForTesting();
  vi.useRealTimers();
});

describe("requestPr", () => {
  it("registers one key per checkout and branch", () => {
    requestPr("/ws", "feat/x");
    requestPr("/ws", "feat/x");
    requestPr("/ws", "feat/y");
    expect(__interestKeys()).toEqual([prKey("/ws", "feat/x"), prKey("/ws", "feat/y")]);
  });

  /// An unbound rail has no branch and a rootless workspace no checkout.
  /// Both are ordinary, and neither is worth a request.
  it("ignores a missing checkout or branch", () => {
    requestPr(null, "feat/x");
    requestPr("/ws", null);
    requestPr("/ws", undefined);
    expect(__interestKeys()).toEqual([]);
  });
});

describe("prReportFor", () => {
  it("finds a report by its pair, and answers undefined for anything else", () => {
    const reports = { [prKey("/ws", "feat/x")]: NONE };
    expect(prReportFor(reports, "/ws", "feat/x")).toBe(NONE);
    expect(prReportFor(reports, "/ws", "feat/y")).toBeUndefined();
    expect(prReportFor(reports, null, "feat/x")).toBeUndefined();
  });
});

describe("refreshPr", () => {
  it("stores what the host answered", async () => {
    await refreshPr("/ws", "feat/x");
    expect(get(prReports)[prKey("/ws", "feat/x")]).toEqual(NONE);
    expect(backend.prStatus).toHaveBeenCalledWith("/ws", "feat/x", false);
  });

  it("passes force through for a human's own refresh", async () => {
    await refreshPr("/ws", "feat/x", true);
    expect(backend.prStatus).toHaveBeenCalledWith("/ws", "feat/x", true);
  });

  /// A dropped call must not blank a chip row: the last reading is more
  /// use than an error nobody can act on.
  it("keeps the previous report when the call throws", async () => {
    await refreshPr("/ws", "feat/x");
    vi.mocked(backend.prStatus).mockRejectedValueOnce(new Error("boom"));
    await refreshPr("/ws", "feat/x");
    expect(get(prReports)[prKey("/ws", "feat/x")]).toEqual(NONE);
  });

  /// `gh` can take twenty seconds and the ticker fires every fifteen, so
  /// without the in-flight guard a slow network stacks requests.
  it("does not stack two calls for the same branch", async () => {
    let release: (value: PrReport) => void = () => {};
    vi.mocked(backend.prStatus).mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = refreshPr("/ws", "feat/x");
    await refreshPr("/ws", "feat/x");
    expect(backend.prStatus).toHaveBeenCalledTimes(1);
    release(NONE);
    await first;
  });
});

describe("startPrPolling", () => {
  it("asks at once rather than after the first interval", async () => {
    vi.useFakeTimers();
    requestPr("/ws", "feat/x");
    startPrPolling();
    expect(backend.prStatus).toHaveBeenCalledTimes(1);
    expect(prPollingRunning()).toBe(true);
  });

  it("keeps asking while something is still interested", async () => {
    vi.useFakeTimers();
    requestPr("/ws", "feat/x");
    startPrPolling();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(vi.mocked(backend.prStatus).mock.calls.length).toBeGreaterThan(1);
  });

  /// Interest expires, and the REPORT goes with it. A pull request
  /// redrawn from a reading nobody has refreshed for an hour is worse
  /// than an empty chip row, because it looks current.
  it("drops both the interest and its report once nobody asks", async () => {
    vi.useFakeTimers();
    requestPr("/ws", "feat/x");
    startPrPolling();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(get(prReports)[prKey("/ws", "feat/x")]).toBeDefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(__interestKeys()).toEqual([]);
    expect(get(prReports)[prKey("/ws", "feat/x")]).toBeUndefined();
  });

  it("stops on its own teardown", async () => {
    vi.useFakeTimers();
    const stop = startPrPolling();
    stop();
    expect(prPollingRunning()).toBe(false);
  });
});
