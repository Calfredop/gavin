import { describe, it, expect } from "vitest";
import { keyedQueue } from "./keyedQueue";

/// A call the test finishes by hand, recording when it started.
function deferred(log: string[], name: string) {
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const work = () => {
    log.push(`start ${name}`);
    return new Promise<string>((resolve, reject) => {
      finish = () => resolve(name);
      fail = reject;
    });
  };
  return { work, finish: () => finish(), fail: (e: Error) => fail(e) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("keyedQueue", () => {
  it("starts a key's next call only once the last one has answered", async () => {
    const queue = keyedQueue();
    const log: string[] = [];
    const first = deferred(log, "first");
    const second = deferred(log, "second");

    const a = queue("/ws/notes.md", first.work);
    const b = queue("/ws/notes.md", second.work);
    await settle();
    expect(log).toEqual(["start first"]);

    first.finish();
    expect(await a).toBe("first");
    await settle();
    expect(log).toEqual(["start first", "start second"]);
    second.finish();
    expect(await b).toBe("second");
  });

  // The newer text is in the call that comes after a failed one.
  it("runs the next call after a failed one, and still reports the failure", async () => {
    const queue = keyedQueue();
    const log: string[] = [];
    const first = deferred(log, "first");
    const second = deferred(log, "second");

    const a = queue("k", first.work);
    const b = queue("k", second.work);
    await settle();
    first.fail(new Error("host did not answer"));
    await expect(a).rejects.toThrow("host did not answer");
    await settle();
    expect(log).toEqual(["start first", "start second"]);
    second.finish();
    expect(await b).toBe("second");
  });

  it("never holds one key behind another", async () => {
    const queue = keyedQueue();
    const log: string[] = [];
    const slow = deferred(log, "slow");
    const other = deferred(log, "other");

    void queue("/ws/a.md", slow.work);
    const b = queue("/ws/b.md", other.work);
    await settle();
    expect(log).toEqual(["start slow", "start other"]);
    other.finish();
    expect(await b).toBe("other");
  });
});
