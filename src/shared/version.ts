export const VERSION = "0.2.3";

/**
 * True when `a` is an older release than `b`. Non-numeric segments compare
 * as 0, so unknown formats never trigger a "downgrade".
 */
export function isVersionOlder(a: string, b: string): boolean {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db;
  }
  return false;
}
