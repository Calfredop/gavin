/// Calls that must reach the host one at a time and in the order they
/// were made, per key.
///
/// A plain `fn` Tauri command runs on the main thread, and the main
/// thread runs one command at a time: two calls made in order were
/// carried out in order, whether or not anybody asked for that. An
/// `async` command runs on a pool, where the second call can overtake the
/// first. For a write that replaces a whole file that is the difference
/// between keeping the newer text and silently keeping the older one --
/// the editor's autosave writes again on the next typing pause, whether
/// or not the last write has answered, and over an ssh link it often
/// has not.
///
/// So each call for a key starts only once every earlier call for that
/// key has settled, succeeded or failed. Different keys never wait on
/// each other.
export type KeyedQueue = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export function keyedQueue(): KeyedQueue {
  // The last call queued for each key, as a promise that never rejects:
  // a failed write must not stop the next one, which is the one carrying
  // the newer text.
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const before = tails.get(key) ?? Promise.resolve();
    const result = before.then(() => work());
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    tails.set(key, tail);
    // Forget a key once nothing is queued behind this call, or the map
    // keeps one entry for every file ever saved.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}
