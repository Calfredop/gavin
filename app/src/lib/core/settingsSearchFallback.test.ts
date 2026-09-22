import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchSettings, type SettingsSection } from "$lib/core/settingsSearch";
import { TYPESAFE_MODEL } from "$lib/agents/turnVerdict";
import {
  FALLBACK_BACKSTOP_MS,
  FALLBACK_DEBOUNCE_MS,
  FALLBACK_MIN_CONFIDENCE,
  SECTION_QUESTION,
  closestSection,
  createSettingsSearchFallback,
  fallbackAllowed,
  fallbackQueryKey,
  fallbackRequest,
  parseFallbackAnswer,
  withClosestMatch,
  type ClosestMatch,
} from "$lib/core/settingsSearchFallback";

// Three of the shipped sections, keywords verbatim, so the request the
// tests inspect is the one the experiment measured: the option VALUES are
// the keyword tables and nothing curated on top.
const SECTIONS: SettingsSection[] = [
  { id: "terminal", keywords: ["Terminal", "Font size", "font"] },
  {
    id: "memory-wall",
    keywords: ["Memory wall", "memory", "RAM", "pressure", "ceiling", "agents running at once"],
  },
  { id: "remote-access", keywords: ["Remote access", "token", "local access", "pairing"] },
];

/// A recorded TypeSafe answer to the one `section` Choice.
function body(choice: string, confidence = 0.93): unknown {
  return {
    model: TYPESAFE_MODEL,
    answers: {
      section: { type: "choice", choice, probabilities: {}, confidence },
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/// The driver wired the way a panel wires it, with the panel's own
/// `$derived` literal search fed in beside the query.
function harness(allowed = true) {
  const ask = vi.fn<[unknown], Promise<unknown>>();
  const onClosest = vi.fn<[ClosestMatch | null], void>();
  const gate = { allowed };
  const fallback = createSettingsSearchFallback({
    ask,
    allowed: () => gate.allowed,
    onClosest,
  });
  const type = (query: string) => fallback.note(SECTIONS, query, searchSettings(SECTIONS, query));
  const last = () => onClosest.mock.calls.at(-1)?.[0];
  return { ask, onClosest, fallback, type, gate, last };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the request", () => {
  it("is the E7 question over the keyword tables, verbatim, on the pinned model", () => {
    const request = fallbackRequest(SECTIONS, "max agents");
    expect(request).toEqual({
      model: "jev-1.13.0",
      state: { search_query: "max agents" },
      questions: {
        section: {
          type: "choice",
          instructions:
            "A user typed `search_query` into the search box of the settings screen of a desktop app that runs AI coding agents in terminals. Each option is one settings section, described by the settings it holds. Which section is the user looking for?",
          criteria: {
            terminal: { settings_in_this_section: ["Terminal", "Font size", "font"] },
            "memory-wall": {
              settings_in_this_section: [
                "Memory wall",
                "memory",
                "RAM",
                "pressure",
                "ceiling",
                "agents running at once",
              ],
            },
            "remote-access": {
              settings_in_this_section: ["Remote access", "token", "local access", "pairing"],
            },
            none: "No section holds a setting for this.",
          },
        },
      },
    });
    expect(request.model).toBe(TYPESAFE_MODEL);
    expect(request.questions.section.instructions).toBe(SECTION_QUESTION);
  });

  it("carries the query with its whitespace settled, so a trailing space is not a new question", () => {
    expect(fallbackQueryKey("  max   agents ")).toBe("max agents");
    expect(fallbackRequest(SECTIONS, "  max   agents ").state.search_query).toBe("max agents");
  });
});

describe("reading the answer", () => {
  it("accepts a section id or none, with a finite confidence", () => {
    expect(parseFallbackAnswer(body("terminal", 0.8), SECTIONS)).toEqual({
      choice: "terminal",
      confidence: 0.8,
    });
    expect(parseFallbackAnswer(body("none", 0.6), SECTIONS)).toEqual({ choice: "none", confidence: 0.6 });
  });

  it("refuses a section this panel does not have, and every shape it cannot read", () => {
    // An option the model was never offered cannot be shown; a build that
    // acted on one would open a section that does not exist here.
    expect(parseFallbackAnswer(body("workspace"), SECTIONS)).toBeNull();
    expect(parseFallbackAnswer(body("terminal", Number.NaN), SECTIONS)).toBeNull();
    expect(parseFallbackAnswer({ answers: { section: { choice: "terminal" } } }, SECTIONS)).toBeNull();
    expect(parseFallbackAnswer({ answers: {} }, SECTIONS)).toBeNull();
    expect(parseFallbackAnswer("upstream connect error", SECTIONS)).toBeNull();
    expect(parseFallbackAnswer(null, SECTIONS)).toBeNull();
  });
});

describe("the policy", () => {
  it("shows the section at or above the floor", () => {
    expect(closestSection({ choice: "terminal", confidence: FALLBACK_MIN_CONFIDENCE })).toBe("terminal");
    expect(closestSection({ choice: "terminal", confidence: 0.93 })).toBe("terminal");
  });

  it("keeps the empty state on none, below the floor, and with no answer at all", () => {
    expect(closestSection({ choice: "none", confidence: 0.99 })).toBeNull();
    expect(closestSection({ choice: "terminal", confidence: FALLBACK_MIN_CONFIDENCE - 0.01 })).toBeNull();
    expect(closestSection(null)).toBeNull();
  });

  it("was measured at 0.5 on jev-1.13.0", () => {
    // 40 of 41 answered and 38 right at this floor; the number is the
    // spec's, not a taste. Moving it is a re-measurement, not an edit.
    expect(FALLBACK_MIN_CONFIDENCE).toBe(0.5);
  });

  it("needs both the toggle and a key, and treats an unread setting as off", () => {
    expect(fallbackAllowed(null)).toBe(false);
    expect(fallbackAllowed(undefined)).toBe(false);
    expect(fallbackAllowed({ enabled: false, hasKey: true })).toBe(false);
    expect(fallbackAllowed({ enabled: true, hasKey: false })).toBe(false);
    expect(fallbackAllowed({ enabled: true, hasKey: true })).toBe(true);
  });
});

describe("what the panel shows", () => {
  it("leaves a literal result alone, closest or not", () => {
    const literal = searchSettings(SECTIONS, "font");
    const shown = withClosestMatch(literal, { id: "memory-wall", query: "font" }, "font");
    expect(shown.closest).toBeNull();
    expect(shown.visible("terminal")).toBe(true);
    expect(shown.visible("memory-wall")).toBe(false);
    expect(shown.shown).toBe(1);
  });

  it("leaves an unfiltered panel alone", () => {
    const shown = withClosestMatch(searchSettings(SECTIONS, ""), null, "");
    expect(shown.filtering).toBe(false);
    expect(shown.closest).toBeNull();
    expect(shown.shown).toBe(3);
  });

  it("shows the one closest section, marked as such, under an empty literal result", () => {
    const literal = searchSettings(SECTIONS, "text size");
    const shown = withClosestMatch(literal, { id: "terminal", query: "text size" }, "text size");
    expect(shown.filtering).toBe(true);
    expect(shown.closest).toBe("terminal");
    expect(shown.visible("terminal")).toBe(true);
    expect(shown.visible("memory-wall")).toBe(false);
    expect(shown.shown).toBe(1);
    expect(shown.total).toBe(3);
  });

  it("does not show an answer to a different query", () => {
    // The state still holds the last answer for a moment after the query
    // moves on; identity of the QUERY, not of any object, is the guard.
    const literal = searchSettings(SECTIONS, "phone");
    const shown = withClosestMatch(literal, { id: "terminal", query: "text size" }, "phone");
    expect(shown.closest).toBeNull();
    expect(shown.shown).toBe(0);
  });

  it("matches the query with its whitespace settled", () => {
    const literal = searchSettings(SECTIONS, "text size ");
    const shown = withClosestMatch(literal, { id: "terminal", query: "text size" }, "text size ");
    expect(shown.closest).toBe("terminal");
  });
});

describe("when the panel asks", () => {
  it("never asks on a literal hit", async () => {
    const h = harness();
    h.type("font");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS * 3);
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.last()).toBeNull();
  });

  it("never asks about an empty box", async () => {
    const h = harness();
    h.type("");
    h.type("   ");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS * 3);
    expect(h.ask).not.toHaveBeenCalled();
  });

  it("asks once per settled query, after the debounce, and shows the answer for it", async () => {
    const h = harness();
    h.ask.mockResolvedValue(body("terminal"));
    h.type("text si");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS / 2);
    h.type("text siz");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS / 2);
    h.type("text size");
    expect(h.ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.ask).toHaveBeenCalledWith(fallbackRequest(SECTIONS, "text size"));
    expect(h.last()).toEqual({ id: "terminal", query: "text size" });
  });

  it("does not ask again when the same query is noted again", async () => {
    const h = harness();
    h.ask.mockResolvedValue(body("terminal"));
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.last()).toEqual({ id: "terminal", query: "text size" });
    // A panel re-runs its effect for reasons that are not a keystroke, and
    // a trailing space is not a different question.
    h.type("text size");
    h.type("text size ");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS * 3);
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.last()).toEqual({ id: "terminal", query: "text size" });
  });

  it("clears the answer the moment the query moves on, before asking again", async () => {
    const h = harness();
    h.ask.mockResolvedValue(body("terminal"));
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.last()).toEqual({ id: "terminal", query: "text size" });
    h.type("text size please");
    expect(h.last()).toBeNull();
  });

  it("drops a superseded answer", async () => {
    const h = harness();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.ask.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    h.type("phone");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.ask).toHaveBeenCalledTimes(2);

    first.resolve(body("terminal"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onClosest).not.toHaveBeenCalledWith({ id: "terminal", query: "text size" });
    expect(h.last()).toBeNull();

    second.resolve(body("remote-access"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ id: "remote-access", query: "phone" });
  });

  it("drops an answer in flight when a literal hit arrives", async () => {
    const h = harness();
    const late = deferred<unknown>();
    h.ask.mockReturnValue(late.promise);
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    h.type("font");
    late.resolve(body("terminal"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onClosest).not.toHaveBeenCalledWith({ id: "terminal", query: "text size" });
    expect(h.last()).toBeNull();
  });

  it("keeps the empty state on none and below the floor", async () => {
    const h = harness();
    h.ask.mockResolvedValueOnce(body("none", 0.95)).mockResolvedValueOnce(body("terminal", 0.3));
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.last()).toBeNull();
    h.type("zoom");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.ask).toHaveBeenCalledTimes(2);
    expect(h.last()).toBeNull();
  });

  it("keeps the empty state on an error, and never throws at the panel", async () => {
    const h = harness();
    h.ask.mockRejectedValue(new Error("TypeSafe answered 401"));
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.last()).toBeNull();
  });

  it("keeps the empty state on a body it cannot read", async () => {
    const h = harness();
    h.ask.mockResolvedValue("upstream connect error");
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.last()).toBeNull();
  });

  it("gives up at the backstop and ignores the answer if it comes later", async () => {
    const h = harness();
    const never = deferred<unknown>();
    h.ask.mockReturnValue(never.promise);
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FALLBACK_BACKSTOP_MS);
    expect(h.last()).toBeNull();
    never.resolve(body("terminal"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onClosest).not.toHaveBeenCalledWith({ id: "terminal", query: "text size" });
  });

  it("sends nothing unless the toggle and the key are both set", async () => {
    const h = harness(false);
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS * 3);
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.last()).toBeNull();
  });

  it("asks once the setting is read, when the same query is noted again", async () => {
    // `typesafeSettings` is null until the host has answered; a query
    // typed before that must not be lost for good.
    const h = harness(false);
    h.ask.mockResolvedValue(body("terminal"));
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS * 3);
    expect(h.ask).not.toHaveBeenCalled();
    h.gate.allowed = true;
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.last()).toEqual({ id: "terminal", query: "text size" });
  });

  it("re-checks the gate at send time", async () => {
    const h = harness();
    h.type("text size");
    h.gate.allowed = false;
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS * 3);
    expect(h.ask).not.toHaveBeenCalled();
  });

  it("drops everything on dispose", async () => {
    const h = harness();
    const late = deferred<unknown>();
    h.ask.mockReturnValue(late.promise);
    h.type("text size");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS);
    h.fallback.dispose();
    late.resolve(body("terminal"));
    await vi.advanceTimersByTimeAsync(FALLBACK_BACKSTOP_MS);
    expect(h.onClosest).not.toHaveBeenCalledWith({ id: "terminal", query: "text size" });
    // Nothing scheduled survives it either.
    h.type("phone");
    await vi.advanceTimersByTimeAsync(FALLBACK_DEBOUNCE_MS * 3);
    expect(h.ask).toHaveBeenCalledTimes(1);
  });
});
