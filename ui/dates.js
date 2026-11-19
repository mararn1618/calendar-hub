export const MINUTE = 60000;
export const SLOT = 15;
const DAY = 86400000;
const pad = value => String(value).padStart(2, '0');

export function localDate(instant = Date.now()) {
  const value = new Date(instant);
  return `${String(value.getFullYear()).padStart(4, '0')}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function localTime(instant) {
  const value = new Date(instant);
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function civilInstant(date) {
  return Date.parse(date + 'T00:00:00Z');
}

export function addDays(date, count) {
  return new Date(civilInstant(date) + count * DAY).toISOString().slice(0, 10);
}

export function differenceInDays(start, end) {
  return Math.round((civilInstant(end) - civilInstant(start)) / DAY);
}

export function monday(date) {
  const weekday = new Date(civilInstant(date)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export function monthStart(date, offset = 0) {
  const value = new Date(civilInstant(date.slice(0, 7) + '-01'));
  value.setUTCMonth(value.getUTCMonth() + offset);
  return value.toISOString().slice(0, 10);
}

export function weekNumber(date) {
  const thursday = new Date(civilInstant(addDays(monday(date), 3)));
  const yearStart = civilInstant(thursday.getUTCFullYear() + '-01-01');
  return Math.floor((thursday.getTime() - yearStart) / (7 * DAY)) + 1;
}

const formatters = new Map();
export function formatDate(date, options) {
  const key = JSON.stringify(options);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options }));
  return formatters.get(key).format(civilInstant(date));
}

export function dateRangeLabel(start, end) {
  const options = { day: 'numeric', month: 'long' };
  if (start === end) return formatDate(start, { weekday: 'long', ...options });
  if (start.slice(0, 7) === end.slice(0, 7)) {
    return `${Number(start.slice(-2))}–${formatDate(end, options)}`;
  }
  const includeYear = start.slice(0, 4) === end.slice(0, 4) ? {} : { year: 'numeric' };
  return `${formatDate(start, { ...options, ...includeYear })} – ${formatDate(end, { ...options, ...includeYear })}`;
}

export function zoneOffset(instant) {
  const minutes = -new Date(instant).getTimezoneOffset();
  const remainder = Math.abs(minutes) % 60;
  return `GMT${minutes >= 0 ? '+' : '−'}${Math.floor(Math.abs(minutes) / 60)}${remainder ? ':' + pad(remainder) : ''}`;
}

export function localMidnight(date) {
  return new Date(date + 'T00:00:00').getTime();
}

export function possibleInstants(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return [];
  const wallTime = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(wallTime)) return [];
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    offsets.add(new Date(wallTime + hours * 60 * MINUTE).getTimezoneOffset());
  }
  return [...offsets].map(offset => wallTime + offset * MINUTE)
    .filter(value => localDate(value) === date && localTime(value) === time)
    .sort((a, b) => a - b);
}

function daySlots(date) {
  const start = localMidnight(date);
  const end = localMidnight(addDays(date, 1));
  const slots = [];
  const seen = new Map();
  for (let instant = start; instant < end; instant += SLOT * MINUTE) {
    const time = localTime(instant);
    const occurrence = seen.get(time) || 0;
    seen.set(time, occurrence + 1);
    slots.push({ key: time + '/' + occurrence, time, instant });
  }
  return { start, end, slots };
}

// Align wall-clock times across columns. A change of offset can remove a slot
// on one date or add a second occurrence of it to the shared ruler.
export function createAxis(dates) {
  const days = new Map(dates.map(date => [date, daySlots(date)]));
  const ordered = [...days.values()].sort((a, b) => b.slots.length - a.slots.length);
  const slots = [...ordered[0].slots];
  const known = new Set(slots.map(slot => slot.key));
  for (const day of ordered.slice(1)) {
    day.slots.forEach((slot, index) => {
      if (known.has(slot.key)) return;
      const after = day.slots.slice(index + 1).find(other => known.has(other.key));
      const position = after ? slots.findIndex(other => other.key === after.key) : slots.length;
      slots.splice(position, 0, slot);
      known.add(slot.key);
    });
  }
  const indexByKey = new Map(slots.map((slot, index) => [slot.key, index]));
  const counts = new Map();
  for (const slot of slots) counts.set(slot.time, (counts.get(slot.time) || 0) + 1);
  for (const day of days.values()) {
    day.byIndex = new Map(day.slots.map(slot => [indexByKey.get(slot.key), slot]));
  }
  function position(date, instant, isEnd = false) {
    const day = days.get(date);
    if (!day.slots.length) return 0;
    const sample = Math.max(day.start, Math.min(day.end - 1, isEnd ? instant - 1 : instant));
    const localSlot = day.slots[Math.floor((sample - day.start) / (SLOT * MINUTE))];
    const duration = Math.max(0, Math.min(SLOT, (instant - localSlot.instant) / MINUTE));
    return indexByKey.get(localSlot.key) * SLOT + duration;
  }
  function instantAt(date, minute, isEnd = false) {
    const day = days.get(date);
    if (minute < 0 || minute > slots.length * SLOT) return null;
    const index = Math.floor(minute / SLOT);
    const slot = day.byIndex.get(index);
    if (isEnd && minute % SLOT === 0 && index > 0) {
      const preceding = day.byIndex.get(index - 1);
      if (preceding) return Math.min(day.end, preceding.instant + SLOT * MINUTE);
    }
    if (!slot) return null;
    return Math.min(day.end, slot.instant + (minute % SLOT) * MINUTE);
  }
  const ticks = slots.flatMap((slot, index) => {
    if (index && !slot.time.endsWith(':00') && !slot.key.endsWith('/1')) return [];
    if (index && !slot.time.endsWith(':00') && slots[index - 1].key.endsWith('/1')) return [];
    return [{ minute: index * SLOT, time: slot.time, offset: counts.get(slot.time) > 1 ? zoneOffset(slot.instant) : '' }];
  });
  return { days, slots, ticks, minutes: slots.length * SLOT, position, instantAt };
}

export function timedLayout(items, day, axis) {
  const { start, end } = axis.days.get(day);
  const segments = [];
  for (const item of items) {
    if (item.allDay) continue;
    const originalStart = Date.parse(item.start);
    const originalEnd = Date.parse(item.end);
    if (!(originalStart < end && (originalEnd > start || (originalStart === originalEnd && originalStart >= start)))) continue;
    const from = axis.position(day, Math.max(start, originalStart));
    const to = axis.position(day, Math.min(end, originalEnd), originalEnd > originalStart);
    segments.push({ item, from, to: Math.max(from + SLOT, to), startsHere: originalStart >= start, endsHere: originalEnd <= end });
  }
  segments.sort((a, b) => a.from - b.from || b.to - a.to);
  let cluster = [];
  let ends = [];
  let clusterEnd = -1;
  function finish() {
    for (const segment of cluster) segment.columns = ends.length;
    cluster = [];
    ends = [];
  }
  for (const segment of segments) {
    if (segment.from >= clusterEnd) {
      finish();
      clusterEnd = segment.to;
    }
    let lane = ends.findIndex(value => value <= segment.from);
    if (lane < 0) lane = ends.length;
    ends[lane] = segment.to;
    segment.column = lane;
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.to);
  }
  finish();
  return segments;
}
