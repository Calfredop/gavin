import { expect, type Mock } from "vitest";

/// Called exactly once, with exactly these arguments. vitest 1.x has the
/// two halves and not the whole; asserting only the arguments would pass
/// for a handler that fired twice.
export function expectOnce(fn: Mock<any[], any>, ...args: unknown[]): void {
  expect(fn).toHaveBeenCalledTimes(1);
  expect(fn).toHaveBeenCalledWith(...args);
}
