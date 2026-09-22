import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/core/backend", () => ({
  typesafeAsk: vi.fn(),
  typesafeSettings: vi.fn(),
}));

import * as backend from "$lib/core/backend";
import { typesafeSettings } from "$lib/agents/turnVerdictState";
import { commitState, type LinkableCard } from "$lib/git/commitCardLink";
import {
  SEARCH_DEBOUNCE_MS,
  __resetForTesting,
  askCardsByMeaning,
  askCommitCardLink,
  cardsByMeaning,
  clearCardsByMeaning,
  clearCommitCardLink,
  commitCardLinks,
} from "$lib/git/commitCardLinkState";

const WS = "ws-1";
const A: LinkableCard = { path: "/ws/.gavin-root/plans/a.md", title: "Git tab: history graph", modifiedAt: 1 };
const B: LinkableCard = { path: "/ws/.gavin-root/plans/b.md", title: "Fix the login flow", modifiedAt: 2 };
const CARDS = [A, B];
const COMMIT = commitState("feat(git): draw the graph", "feat(git): draw the graph\n\nBecause.", ["a.ts"]);

function body(choice: string, confidence: number, probabilities: Record<string, number>) {
  return { answers: { card: { type: "choice", choice, confidence, probabilities } } };
}

/// A promise the test resolves by hand, so it can look at the store
/// while the request is in flight.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/// Lets every microtask the driver chains -- the settings gate, the
/// request, the settle -- run to the end.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  __resetForTesting();
  vi.mocked(backend.typesafeAsk).mockReset();
  vi.mocked(backend.typesafeSettings).mockReset();
  typesafeSettings.set({ enabled: true, hasKey: true, changeAttribution: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("askCommitCardLink", () => {
  it("asks nothing while the switch is off, and leaves no slot behind", async () => {
    typesafeSettings.set({ enabled: false, hasKey: true, changeAttribution: false });
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    expect(backend.typesafeAsk).not.toHaveBeenCalled();
    // Not even a `read` slot: a commit nobody asked about must look
    // exactly like one on a build without this feature.
    expect(get(commitCardLinks)).toEqual({});
  });

  it("asks nothing without a key", async () => {
    typesafeSettings.set({ enabled: true, hasKey: false, changeAttribution: false });
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    expect(backend.typesafeAsk).not.toHaveBeenCalled();
    expect(get(commitCardLinks)).toEqual({});
  });

  it("reads the settings from the host when nobody has yet", async () => {
    // The turn-verdict driver loads them once per window, but the Git
    // tab can be the first thing opened. Null must not mean "off" for
    // ever; it means "ask the host".
    typesafeSettings.set(null);
    vi.mocked(backend.typesafeSettings).mockResolvedValue({ enabled: true, hasKey: true, changeAttribution: false });
    vi.mocked(backend.typesafeAsk).mockResolvedValue(body("card_01", 0.9, { card_01: 0.9, card_02: 0.1, none: 0 }));
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    expect(backend.typesafeSettings).toHaveBeenCalledTimes(1);
    expect(backend.typesafeAsk).toHaveBeenCalledTimes(1);
  });

  it("stays off when the host cannot say", async () => {
    typesafeSettings.set(null);
    vi.mocked(backend.typesafeSettings).mockRejectedValue(new Error("no config"));
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    expect(backend.typesafeAsk).not.toHaveBeenCalled();
  });

  it("asks nothing for an empty board", async () => {
    // A Choice with only `none` on it has nothing to answer.
    askCommitCardLink(WS, "abc", COMMIT, []);
    await flush();
    expect(backend.typesafeAsk).not.toHaveBeenCalled();
    expect(get(commitCardLinks)).toEqual({});
  });

  it("marks the commit pending, then reads the link the answer names", async () => {
    const d = deferred<unknown>();
    vi.mocked(backend.typesafeAsk).mockReturnValue(d.promise);
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    expect(get(commitCardLinks)[WS]).toEqual({ key: "abc", entry: { state: "pending" } });
    d.resolve(body("card_02", 0.88, { card_01: 0.1, card_02: 0.88, none: 0.02 }));
    await flush();
    expect(get(commitCardLinks)[WS]).toEqual({
      key: "abc",
      entry: { state: "read", link: { kind: "card", card: B, confidence: 0.88 } },
    });
  });

  it("sends the commit and the board's titles, and nothing else of the cards", async () => {
    vi.mocked(backend.typesafeAsk).mockResolvedValue(body("none", 0.9, { card_01: 0.05, card_02: 0.05, none: 0.9 }));
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    const [request] = vi.mocked(backend.typesafeAsk).mock.calls[0] as [Record<string, unknown>];
    expect(request.model).toBe("jev-1.13.0");
    expect(request.state).toEqual({ commit: COMMIT });
    const wire = JSON.stringify(request);
    expect(wire).toContain("Git tab: history graph");
    expect(wire).not.toContain("plans/a.md");
    // `none` reads as no link, and is still a settled answer.
    expect(get(commitCardLinks)[WS]).toEqual({ key: "abc", entry: { state: "read", link: null } });
  });

  it("asks once per commit, however often the pane re-renders", async () => {
    vi.mocked(backend.typesafeAsk).mockResolvedValue(body("card_01", 0.9, { card_01: 0.9, card_02: 0.1, none: 0 }));
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    expect(backend.typesafeAsk).toHaveBeenCalledTimes(1);
  });

  it("drops an answer for a commit the human has moved on from", async () => {
    const first = deferred<unknown>();
    vi.mocked(backend.typesafeAsk)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(body("card_02", 0.9, { card_01: 0.1, card_02: 0.9, none: 0 }));
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    askCommitCardLink(WS, "def", commitState("fix: login", "fix: login", []), CARDS);
    await flush();
    expect(get(commitCardLinks)[WS]).toEqual({
      key: "def",
      entry: { state: "read", link: { kind: "card", card: B, confidence: 0.9 } },
    });
    first.resolve(body("card_01", 0.95, { card_01: 0.95, card_02: 0.05, none: 0 }));
    await flush();
    // Still the second commit's answer: the first landed nowhere.
    expect(get(commitCardLinks)[WS].key).toBe("def");
    expect(get(commitCardLinks)[WS].entry).toEqual({
      state: "read",
      link: { kind: "card", card: B, confidence: 0.9 },
    });
  });

  it("reads a failed request as no link", async () => {
    vi.mocked(backend.typesafeAsk).mockRejectedValue(new Error("TypeSafe answered 500"));
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    expect(get(commitCardLinks)[WS]).toEqual({ key: "abc", entry: { state: "read", link: null } });
  });

  it("reads a body this build cannot parse as no link", async () => {
    vi.mocked(backend.typesafeAsk).mockResolvedValue({ answers: { card: { choice: "card_77", confidence: 0.99 } } });
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    expect(get(commitCardLinks)[WS]).toEqual({ key: "abc", entry: { state: "read", link: null } });
  });

  it("clearing forgets the slot and drops the answer in flight", async () => {
    const d = deferred<unknown>();
    vi.mocked(backend.typesafeAsk).mockReturnValue(d.promise);
    askCommitCardLink(WS, "abc", COMMIT, CARDS);
    await flush();
    clearCommitCardLink(WS);
    expect(get(commitCardLinks)).toEqual({});
    d.resolve(body("card_01", 0.9, { card_01: 0.9, card_02: 0.1, none: 0 }));
    await flush();
    expect(get(commitCardLinks)).toEqual({});
  });

  it("keeps one slot per workspace", async () => {
    vi.mocked(backend.typesafeAsk).mockResolvedValue(body("card_01", 0.9, { card_01: 0.9, card_02: 0.1, none: 0 }));
    askCommitCardLink("ws-1", "abc", COMMIT, CARDS);
    askCommitCardLink("ws-2", "abc", COMMIT, CARDS);
    await flush();
    expect(Object.keys(get(commitCardLinks)).sort()).toEqual(["ws-1", "ws-2"]);
    clearCommitCardLink("ws-1");
    expect(Object.keys(get(commitCardLinks))).toEqual(["ws-2"]);
  });
});

describe("askCardsByMeaning", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("waits for the typing to settle before asking, and asks the query as it settled", async () => {
    vi.mocked(backend.typesafeAsk).mockResolvedValue(body("card_01", 0.9, { card_01: 0.9, card_02: 0.1, none: 0 }));
    askCardsByMeaning(WS, "histor", CARDS);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 100);
    askCardsByMeaning(WS, "history of commits", CARDS);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    await flush();
    expect(backend.typesafeAsk).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(backend.typesafeAsk).toHaveBeenCalledTimes(1);
    const [request] = vi.mocked(backend.typesafeAsk).mock.calls[0] as [Record<string, unknown>];
    expect(request.state).toEqual({ search_query: "history of commits" });
    expect(get(cardsByMeaning)[WS]).toEqual({
      key: "history of commits",
      entry: { state: "read", link: { kind: "card", card: A, confidence: 0.9 } },
    });
    expect(SEARCH_DEBOUNCE_MS).toBe(400);
  });

  it("clearing before the timer fires asks nothing", async () => {
    askCardsByMeaning(WS, "history", CARDS);
    clearCardsByMeaning(WS);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    await flush();
    expect(backend.typesafeAsk).not.toHaveBeenCalled();
    expect(get(cardsByMeaning)).toEqual({});
  });

  it("asks a settled query once, not again on every re-render", async () => {
    vi.mocked(backend.typesafeAsk).mockResolvedValue(body("card_01", 0.9, { card_01: 0.9, card_02: 0.1, none: 0 }));
    askCardsByMeaning(WS, "history", CARDS);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    await flush();
    askCardsByMeaning(WS, "history", CARDS);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    await flush();
    expect(backend.typesafeAsk).toHaveBeenCalledTimes(1);
  });

  it("drops the answer to a query that was typed over", async () => {
    const first = deferred<unknown>();
    vi.mocked(backend.typesafeAsk)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(body("card_02", 0.6, { card_01: 0.3, card_02: 0.6, none: 0.1 }));
    askCardsByMeaning(WS, "one", CARDS);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    await flush();
    expect(get(cardsByMeaning)[WS]).toEqual({ key: "one", entry: { state: "pending" } });
    askCardsByMeaning(WS, "two", CARDS);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    await flush();
    first.resolve(body("card_01", 0.95, { card_01: 0.95, card_02: 0.05, none: 0 }));
    await flush();
    expect(get(cardsByMeaning)[WS]).toEqual({
      key: "two",
      entry: { state: "read", link: { kind: "candidates", cards: [B, A] } },
    });
  });

  it("asks nothing while the switch is off", async () => {
    typesafeSettings.set({ enabled: false, hasKey: false, changeAttribution: false });
    askCardsByMeaning(WS, "history", CARDS);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    await flush();
    expect(backend.typesafeAsk).not.toHaveBeenCalled();
    expect(get(cardsByMeaning)).toEqual({});
  });
});
