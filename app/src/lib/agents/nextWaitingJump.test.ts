import { describe, it, expect } from "vitest";
import { nextWaitingJump, provideNextWaitingJump } from "$lib/agents/nextWaitingJump";

describe("nextWaitingJump", () => {
  it("is nothing with no button on screen", () => {
    expect(nextWaitingJump()).toBeNull();
  });

  it("is the button's own answer: its jump, or null when nothing waits", () => {
    const go = () => {};
    let offer: (() => void) | null = go;
    const withdraw = provideNextWaitingJump(() => offer);
    expect(nextWaitingJump()).toBe(go);
    offer = null;
    expect(nextWaitingJump()).toBeNull();
    withdraw();
  });

  // Two buttons are mounted for a moment while the top row changes hands.
  // The newest is the one on screen, and the one leaving must withdraw
  // only its own offer -- whichever order the two lifecycles run in.
  it("answers with the newest button, and a withdrawal takes only its own", () => {
    const first = () => {};
    const second = () => {};
    const withdrawFirst = provideNextWaitingJump(() => first);
    const withdrawSecond = provideNextWaitingJump(() => second);
    expect(nextWaitingJump()).toBe(second);
    withdrawFirst();
    expect(nextWaitingJump()).toBe(second);
    withdrawSecond();
    expect(nextWaitingJump()).toBeNull();
  });

  it("withdraws once, however often it is called", () => {
    const keep = () => {};
    const withdrawKeep = provideNextWaitingJump(() => keep);
    const withdrawGone = provideNextWaitingJump(() => () => {});
    withdrawGone();
    withdrawGone();
    expect(nextWaitingJump()).toBe(keep);
    withdrawKeep();
  });
});
