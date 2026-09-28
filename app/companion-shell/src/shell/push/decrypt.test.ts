import { describe, it, expect } from "vitest";
import { deepLinkFor, NOTIFY_GENERIC_BODY } from "./decrypt";

describe("deepLinkFor", () => {
  it("opens the hub when decrypt failed", () => {
    expect(deepLinkFor(null, "ws-1")).toBe("gavin://hub");
  });

  it("opens the session on a notify", () => {
    expect(
      deepLinkFor(
        {
          op: "notify",
          id: "session:s1",
          target: { type: "session", session_id: "s1" },
        },
        "ws-1",
      ),
    ).toBe("gavin://ws/ws-1/session/s1");
  });

  it("keeps the generic body string stable", () => {
    expect(NOTIFY_GENERIC_BODY).toBe("Something on your Workstation changed.");
  });
});
