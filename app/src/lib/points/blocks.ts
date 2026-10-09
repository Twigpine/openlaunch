/**
 * The last block whose time is before `ms`, given `lo` (time before `ms`) and `hi` (time at or after it), reading
 * block times through `timeOf`. Interpolated on time (block times are near constant, so a few reads land it),
 * halving whenever a guess did not halve the range, so the worst case stays logarithmic.
 */
export async function lastBlockBetween(lo: bigint, tLo: number, hi: bigint, tHi: number, ms: number, timeOf: (b: bigint) => Promise<number>): Promise<bigint> {
  if (!(tLo < ms && ms <= tHi) || hi <= lo) throw new Error("lastBlockBetween: the range does not bracket the time");
  let halve = false;
  while (hi - lo > 1n) {
    const width = hi - lo;
    let mid = (lo + hi) / 2n;
    if (!halve && tHi > tLo) {
      mid = lo + BigInt(Math.floor((Number(width) * (ms - tLo)) / (tHi - tLo)));
      if (mid <= lo) mid = lo + 1n;
      if (mid >= hi) mid = hi - 1n;
    }
    const t = await timeOf(mid);
    if (t < ms) [lo, tLo] = [mid, t];
    else [hi, tHi] = [mid, t];
    halve = !halve && (hi - lo) * 2n > width; // a guess that did not halve the range: halve next
  }
  return lo;
}
