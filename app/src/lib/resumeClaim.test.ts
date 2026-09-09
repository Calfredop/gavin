import { describe, it, expect } from "vitest";
import { CLAIM_TTL_MS, ResumeClaims, claimKey } from "$lib/resumeClaim";

function at(now: { t: number }) {
  return new ResumeClaims(() => now.t);
}

describe("ResumeClaims", () => {
  it("gives the claim to exactly one caller", () => {
    const now = { t: 1000 };
    const claims = at(now);
    const key = claimKey("claude-code", "sess-1");
    expect(claims.tryClaim(key)).toBe(true);
    expect(claims.tryClaim(key)).toBe(false);
  });

  // The race this exists for: the automatic trigger and the human's
  // press land in the same instant, because the notification that
  // prompts the human arrives exactly when the trigger fires.
  it("keeps the automatic resume and the manual press from both firing", () => {
    const now = { t: 1000 };
    const claims = at(now);
    const key = claimKey("claude-code", "sess-1");
    const automatic = claims.tryClaim(key);
    const manual = claims.tryClaim(key);
    expect([automatic, manual]).toEqual([true, false]);
  });

  it("guards each session separately", () => {
    const now = { t: 1000 };
    const claims = at(now);
    expect(claims.tryClaim(claimKey("claude-code", "sess-1"))).toBe(true);
    expect(claims.tryClaim(claimKey("claude-code", "sess-2"))).toBe(true);
    // ...and the agent kind is part of the key, not decoration.
    expect(claims.tryClaim(claimKey("opencode", "sess-1"))).toBe(true);
  });

  // A permanent claim would block a LEGITIMATE resume of the same
  // session later, when the agent really has exited -- turning a race
  // guard into a run nothing can ever recover.
  it("expires rather than persisting", () => {
    const now = { t: 1000 };
    const claims = at(now);
    const key = claimKey("claude-code", "sess-1");
    expect(claims.tryClaim(key)).toBe(true);

    now.t += CLAIM_TTL_MS - 1;
    expect(claims.tryClaim(key)).toBe(false);

    now.t += 1;
    expect(claims.tryClaim(key)).toBe(true);
  });

  // For the caller that takes a claim and then fails to launch. Without
  // this, a refused spawn holds the session shut for the full TTL --
  // during exactly the minute the human is most likely to press Resume
  // themselves and watch nothing happen.
  it("can be given back early by a caller that failed to launch", () => {
    const now = { t: 1000 };
    const claims = at(now);
    const key = claimKey("claude-code", "sess-1");
    claims.tryClaim(key);
    claims.release(key);
    expect(claims.tryClaim(key)).toBe(true);
  });

  it("reports whether a claim stands, for a surface that only wants to explain", () => {
    const now = { t: 1000 };
    const claims = at(now);
    const key = claimKey("claude-code", "sess-1");
    expect(claims.isHeld(key)).toBe(false);
    claims.tryClaim(key);
    expect(claims.isHeld(key)).toBe(true);
    now.t += CLAIM_TTL_MS + 1;
    expect(claims.isHeld(key)).toBe(false);
  });
});
