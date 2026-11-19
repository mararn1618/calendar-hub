const day = 86_400_000;
const windowDays = 12;
export const inventoryFreshness = 60 * 60_000;
export const tickTickSyncMinutes = [0, 1, 2, 5, 10, 15, 30, 60];
export const defaultSyncMinutes = 5;

export function recentlyChecked(timestamp, maxAge, now = Date.now()) {
  const age = now - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age < maxAge;
}

export function recentTaskChecks(checks, zone, minutes, now = Date.now()) {
  return checks.filter(check => check.zone === zone &&
    recentlyChecked(Date.parse(check.checkedAt), minutes ? minutes * 60_000 : Infinity, now));
}

const shiftDay = (date, days) => new Date(Date.parse(date) + days * day).toISOString().slice(0, 10);
const intersects = (a, b) => a.start < b.end && a.end > b.start;

export function outsideWindow(ranges, window) {
  return ranges.flatMap(range => {
    if (range.zone !== window.zone || !intersects(range, window)) return [range];
    const remaining = [];
    if (range.start < window.start) remaining.push({ ...range, end: window.start });
    if (range.end > window.end) remaining.push({ ...range, start: window.end });
    return remaining;
  });
}

export function retryTime(failure, minutes) {
  return failure.error.retryAt ?? failure.at + minutes * 60_000;
}

function readWindow(range, preload) {
  if (preload) {
    const daysSinceMonday = (new Date(range.start).getUTCDay() + 6) % 7;
    const start = shiftDay(range.start, -Math.min(4, daysSinceMonday));
    const end = shiftDay(start, windowDays);
    if (range.end <= end) return { start, end };
  }
  return range;
}

function gapsBetween(start, end, checks) {
  const gaps = [];
  let cursor = start;
  for (const check of checks) {
    if (check.end <= cursor) continue;
    if (check.start >= end) break;
    if (check.start > cursor) gaps.push({ start: cursor, end: check.start });
    cursor = check.end;
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push({ start: cursor, end });
  return gaps;
}

export function planTickTickReads(jobs, checksFor, preload = true) {
  const batches = new Map();
  for (const job of jobs) {
    const checks = [...checksFor(job)].sort((a, b) => a.start.localeCompare(b.start));
    const window = readWindow(job, preload);
    for (let start = window.start; start < window.end;) {
      const limit = shiftDay(start, windowDays);
      const end = limit < window.end ? limit : window.end;
      const gaps = gapsBetween(start, end, checks).filter(gap => intersects(gap, job));
      if (gaps.length) {
        const key = start + '/' + end;
        const batch = batches.get(key) ?? { start: gaps[0].start, end: gaps.at(-1).end, sources: new Set() };
        if (batch.start > gaps[0].start) batch.start = gaps[0].start;
        if (batch.end < gaps.at(-1).end) batch.end = gaps.at(-1).end;
        batch.sources.add(job.source);
        batches.set(key, batch);
      }
      start = end;
    }
  }
  return batches.values();
}
