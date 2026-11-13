/** Pure (node --test loads it directly): one run per key at a time, never queued behind a run that may be stuck. */

/**
 * Start `fn` for `key` unless a run for that key is still going. A key already running is skipped, not waited on, and
 * the caller gets null: two callers never do the same work side by side, and a slow or stuck run never holds up the
 * callers after it. The key is free again once its run settles, whether it resolved or rejected.
 */
export function startUnlessRunning<K>(running: Map<K, Promise<void>>, key: K, fn: () => Promise<void>): Promise<void> | null {
  if (running.has(key)) return null;
  const p: Promise<void> = fn().finally(() => {
    if (running.get(key) === p) running.delete(key);
  });
  running.set(key, p);
  return p;
}
