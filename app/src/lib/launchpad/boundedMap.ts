/**
 * Put a key into a bounded retry map without throwing the map away. On overflow, entries the caller marks expired are
 * dropped first; if the map is still full, the oldest insertions go. Refreshing an existing key also refreshes its
 * insertion order, so a row that is actively being retried is not the next one evicted.
 */
export function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number,
  expired: (value: V, now: number) => boolean,
  now: number,
): void {
  if (max < 1) return;
  if (!map.has(key) && map.size >= max) {
    for (const [k, v] of map) if (expired(v, now)) map.delete(k);
    while (map.size >= max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  map.delete(key);
  map.set(key, value);
}
