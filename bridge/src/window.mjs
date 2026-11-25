// A usage window as every panel shows it.

/** One window, normalised. A window whose reset time has passed is full again. */
export function windowOf(kind, usedPercent, resetsAtSeconds, now = Date.now()) {
  const resetsAt = Number.isFinite(resetsAtSeconds) ? resetsAtSeconds * 1000 : null;
  const reset = resetsAt !== null && resetsAt <= now;
  const used = reset ? 0 : Math.max(0, Math.min(100, Number(usedPercent) || 0));
  return { kind, usedPercent: used, leftPercent: 100 - used, resetsAt: reset ? null : resetsAt, reset };
}
