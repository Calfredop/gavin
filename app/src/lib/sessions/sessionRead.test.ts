import { describe, it, expect } from "vitest";
import {
  attentionStatus,
  attentionStatuses,
  canMarkRead,
  clearSessionRead,
  readEntryApplies,
  readEntryLabel,
  withSessionRead,
} from "$lib/sessions/sessionRead";
import type { SessionStatus } from "$lib/core/notifications";

describe("canMarkRead", () => {
  it("is true for the one status that nags", () => {
    expect(canMarkRead("waiting_for_input")).toBe(true);
  });

  // `failed` carries a reason the human has to act on and `working`/`idle`
  // ask for nothing, so none of them has a wait to acknowledge.
  it.each<SessionStatus | undefined>(["working", "idle", "failed", "unknown", undefined])(
    "is false for %s",
    (status) => {
      expect(canMarkRead(status)).toBe(false);
    }
  );
});

describe("readEntryApplies", () => {
  it("offers the entry on a waiting session", () => {
    expect(readEntryApplies("waiting_for_input", false)).toBe(true);
  });

  it("keeps offering it once marked, so a mistake can be undone", () => {
    // The mark hides the status from every badge; without this the only
    // way back would be to wait for the agent to ask something else.
    expect(readEntryApplies("waiting_for_input", true)).toBe(true);
  });

  it("stays off a tab with nothing to read", () => {
    expect(readEntryApplies("idle", false)).toBe(false);
  });
});

describe("readEntryLabel", () => {
  it("names the action, never the state", () => {
    expect(readEntryLabel(false)).toBe("Mark as Read");
    expect(readEntryLabel(true)).toBe("Mark as Unread");
  });
});

describe("withSessionRead", () => {
  it("marks and unmarks", () => {
    const marked = withSessionRead(new Set(), "s1", true);
    expect([...marked]).toEqual(["s1"]);
    expect([...withSessionRead(marked, "s1", false)]).toEqual([]);
  });

  it("leaves the other sessions alone", () => {
    const marks = withSessionRead(new Set(["s1"]), "s2", true);
    expect([...marks].sort()).toEqual(["s1", "s2"]);
  });

  it("hands back the same set for a no-op, so a store cannot churn", () => {
    const marks = new Set(["s1"]);
    expect(withSessionRead(marks, "s1", true)).toBe(marks);
    expect(withSessionRead(marks, "s2", false)).toBe(marks);
  });
});

describe("clearSessionRead", () => {
  it("drops a mark whatever it was", () => {
    expect([...clearSessionRead(new Set(["s1", "s2"]), "s1")]).toEqual(["s2"]);
    const marks = new Set(["s2"]);
    expect(clearSessionRead(marks, "s1")).toBe(marks);
  });
});

describe("attentionStatus", () => {
  it("shows an acknowledged wait as idle", () => {
    expect(attentionStatus("waiting_for_input", true)).toBe("idle");
  });

  it("leaves an unacknowledged wait alone", () => {
    expect(attentionStatus("waiting_for_input", false)).toBe("waiting_for_input");
  });

  // Defensive rather than reachable: a mark is dropped by the next status
  // the daemon reports, so a marked session is always a waiting one. If
  // that ever slipped, masking `failed` would hide the one status that
  // carries a reason.
  it("masks nothing but a wait", () => {
    expect(attentionStatus("failed", true)).toBe("failed");
    expect(attentionStatus("working", true)).toBe("working");
    expect(attentionStatus(undefined, true)).toBeUndefined();
  });
});

describe("attentionStatuses", () => {
  const statuses: Record<string, SessionStatus> = {
    a: "waiting_for_input",
    b: "working",
    c: "waiting_for_input",
  };

  it("masks only the marked sessions", () => {
    expect(attentionStatuses(statuses, new Set(["a"]))).toEqual({
      a: "idle",
      b: "working",
      c: "waiting_for_input",
    });
  });

  it("never mutates the map it was given", () => {
    attentionStatuses(statuses, new Set(["a", "c"]));
    expect(statuses.a).toBe("waiting_for_input");
  });

  // Identity matters: this feeds a derived store, and a fresh object on
  // every unrelated layout change would invalidate every consumer of it.
  it("hands back the original map when no mark applies", () => {
    expect(attentionStatuses(statuses, new Set())).toBe(statuses);
    expect(attentionStatuses(statuses, new Set(["b"]))).toBe(statuses);
    expect(attentionStatuses(statuses, new Set(["gone"]))).toBe(statuses);
  });
});
