/** Per-process backstop across IPs. Production also needs provider/edge quotas. */
export function rpcBudget(maximumActive = 12, startsPerMinute = 300) {
  let active = 0;
  let starts = 0;
  let windowStart = 0;
  return function acquire(now = Date.now()): (() => void) | null {
    if (now - windowStart >= 60_000) {
      windowStart = now;
      starts = 0;
    }
    if (active >= maximumActive || starts >= startsPerMinute) return null;
    active++;
    starts++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        active--;
      }
    };
  };
}
