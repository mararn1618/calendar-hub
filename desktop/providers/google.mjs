import { createHash, randomUUID } from 'node:crypto';

export { authorizeGoogle, refreshGoogleToken } from './google-auth.mjs';

const calendarApi = 'https://www.googleapis.com/calendar/v3';
const writeRoles = new Set(['owner', 'writer', 'writerWithoutPrivateAccess']);
const dayMs = 86_400_000;
const zoneFormats = new Map();

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function unreadable() {
  return error('PROVIDER', 'Google returned incomplete calendar data. Refresh to try again.');
}

function uncertain() {
  return error('UNCERTAIN', 'Google may have applied the change. Refresh and check the calendar before trying again.');
}

function identifier(id) {
  if (typeof id !== 'string' || !id.trim() || id === '.' || id === '..' || /[\u0000-\u001f]/.test(id)) throw unreadable();
  return encodeURIComponent(id);
}

function hasVersion(value) {
  return typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]+"$/.test(value);
}

function civil(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function wallTime(instant, zone) {
  if (!zoneFormats.has(zone)) {
    zoneFormats.set(zone, new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  const parts = Object.fromEntries(zoneFormats.get(zone).formatToParts(instant).map(part => [part.type, part.value]));
  return parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute + ':' + parts.second;
}

function inZone(wall, zone) {
  const target = Date.parse(wall + 'Z');
  const wholeSecond = Math.floor(target / 1000) * 1000;
  const offsets = [-dayMs, dayMs].map(delta => {
    const sample = wholeSecond + delta;
    return Date.parse(wallTime(sample, zone) + 'Z') - sample;
  });
  // Prefer the first occurrence in a fold and move forward across a missing wall time.
  const candidates = offsets.map(offset => target - offset).sort((a, b) => a - b);
  return candidates.find(candidate => Date.parse(wallTime(candidate, zone) + 'Z') >= wholeSecond);
}

function instant(value, zone) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (match && civil(match[1])) {
    const ms = match[2] ? Date.parse(value) : zone && inZone(value, zone);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  throw error('INVALID_DATE', 'Use a calendar date or a time with a valid time zone.');
}

function windowFor(start, end, localZone, calendarZone) {
  const bound = value => civil(value) ? new Date(inZone(value + 'T00:00:00', localZone)).toISOString() : instant(value);
  const from = bound(start);
  const until = bound(end);
  if (from >= until) throw error('INVALID_DATE', 'The calendar range must end after it starts.');
  const firstDay = wallTime(Date.parse(from), localZone).slice(0, 10);
  const lastDay = wallTime(Date.parse(until) - 1, localZone).slice(0, 10);
  let timeMin = from;
  let timeMax = until;
  if (calendarZone && calendarZone !== localZone) {
    // Google tests all-day overlap in the source calendar's zone.
    const followingDay = new Date(Date.parse(lastDay) + dayMs).toISOString().slice(0, 10);
    timeMin = new Date(Math.min(Date.parse(from), inZone(firstDay + 'T00:00:00', calendarZone))).toISOString();
    timeMax = new Date(Math.max(Date.parse(until), inZone(followingDay + 'T00:00:00', calendarZone))).toISOString();
  }
  return { from, until, firstDay, lastDay, timeMin, timeMax };
}

function eventItem(raw, source, zone, role) {
  identifier(raw.id);
  const allDay = raw.start?.date != null;
  const start = allDay ? raw.start.date : instant(raw.start?.dateTime, raw.start?.timeZone || zone);
  const end = allDay ? raw.end?.date : instant(raw.end?.dateTime, raw.end?.timeZone || zone);
  if (allDay ? !civil(start) || !civil(end) || start >= end : start > end) throw unreadable();

  const organizer = raw.organizer?.self === true;
  const attendees = raw.attendees || [];
  const guest = attendees.some(person => person.self && !person.organizer);
  const hasAttendees = raw.attendeesOmitted === true || attendees.some(person =>
    person.additionalGuests > 0 || (!person.organizer && !(person.self && organizer)));
  const series = Array.isArray(raw.recurrence);
  const recurring = Boolean(raw.recurringEventId || series);
  const privateEvent = raw.visibility === 'private' || raw.visibility === 'confidential';
  const writable = source.writable === true && (!role || writeRoles.has(role)) && !raw.locked && !series &&
    (!raw.eventType || raw.eventType === 'default') && raw.recurringEventId !== raw.id && hasVersion(raw.etag) &&
    !(role === 'writerWithoutPrivateAccess' && privateEvent);
  return {
    id: raw.id, providerCalendarId: source.id,
    title: raw.summary || (privateEvent || role === 'freeBusyReader' ? 'Busy' : '(Untitled event)'),
    start, end, allDay, completed: false, canComplete: false,
    canEdit: writable && (organizer || (guest && raw.guestsCanModify === true)),
    canDelete: writable && organizer, recurring, hasAttendees, version: hasVersion(raw.etag) ? raw.etag : null,
  };
}

function inWindow(item, range) {
  if (item.allDay) return item.start <= range.lastDay && item.end > range.firstDay;
  if (item.start === item.end) return item.start >= range.from && item.start < range.until;
  return item.start < range.until && item.end > range.from;
}

function requireCalendar(source) {
  if (source.writable !== true) throw error('READ_ONLY', 'This Google calendar is read-only.');
}

function reviewChange(source, original, options, permission) {
  requireCalendar(source);
  if (original.providerCalendarId && original.providerCalendarId !== source.id) throw error('INVALID', 'Choose this event on its original Google calendar.');
  if (!original[permission] || !hasVersion(original.version)) throw error('READ_ONLY', 'This Google event is read-only.');
  if (original.recurring && options.occurrence !== true && options.occurrence !== 'this') {
    throw error('REVIEW_REQUIRED', 'Confirm the change to this occurrence of the Google event.');
  }
  if (original.hasAttendees && options.notify !== true) throw error('REVIEW_REQUIRED', 'Review the change and confirm that Google may notify the guests.');
}

function eventFields(draft, original, zone) {
  if (typeof draft.title !== 'string' || !draft.title.trim()) throw error('INVALID', 'Enter an event title.');
  if (typeof draft.allDay !== 'boolean') throw error('INVALID_DATE', 'Choose an all-day event or a time slot.');
  const { allDay } = draft;
  let start, end;
  if (allDay) {
    start = draft.start;
    end = draft.end;
    if (!civil(start) || !civil(end)) throw error('INVALID_DATE', 'All-day events need a start date and an exclusive end date.');
  } else {
    start = instant(draft.start);
    end = instant(draft.end);
  }
  if (start >= end) throw error('INVALID_DATE', 'The event must end after it starts.');
  const fields = {};
  if (draft.title !== original?.title) fields.summary = draft.title;
  for (const [key, value] of [['start', start], ['end', end]]) {
    if (original?.allDay === allDay && original[key] === value) continue;
    fields[key] = allDay ? { date: value } : { dateTime: value };
    if (!allDay && (!original || original.allDay)) fields[key].timeZone = zone;
    if (original && original.allDay !== allDay) {
      if (allDay) Object.assign(fields[key], { dateTime: null, timeZone: null });
      else fields[key].date = null;
    }
  }
  return fields;
}

export function createGoogle({
  getAccessToken, apiBase = calendarApi, fetchImpl = fetch,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}) {
  const base = apiBase.replace(/\/+$/, '') + '/';
  const events = source => 'calendars/' + identifier(source.id) + '/events';

  async function request(path, { method = 'GET', params, body, version } = {}) {
    const url = new URL(base + path);
    if (params) url.search = new URLSearchParams(params);
    const token = await getAccessToken();
    if (typeof token !== 'string' || !token) throw error('AUTH_REQUIRED', 'Connect Google to continue.');
    const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
    if (body) headers['Content-Type'] = 'application/json';
    if (version) headers['If-Match'] = version;
    const writing = method !== 'GET';
    let response;
    try {
      response = await fetchImpl(url.href, { method, headers, body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      if (writing) throw uncertain();
      throw error('NETWORK', 'Could not reach Google Calendar. Check your connection.');
    }
    if (!response.ok) {
      const { status } = response;
      const failure = status === 403 ? await response.json().catch(() => null) : null;
      if (status !== 403) await response.body?.cancel().catch(() => {});
      if (status === 401) throw error('AUTH_REQUIRED', 'Google sign-in has expired. Connect Google again.');
      if (status === 429 || failure?.error?.errors?.some(detail => ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(detail.reason))) {
        throw error('RATE_LIMITED', 'Google Calendar reached its request limit. Try again later.');
      }
      if (status === 403) throw error('PERMISSION', 'Google denied access. Check your calendar permissions.');
      if (status === 412 || status === 409 || (version && [404, 410].includes(status))) {
        throw Object.assign(error('CONFLICT', 'This Google event changed. Refresh before editing it again.'), { status });
      }
      if (writing && (status >= 500 || status === 408)) throw uncertain();
      throw error('PROVIDER', 'Google Calendar rejected the request (HTTP ' + status + ').');
    }
    if (writing && response.status === 202) throw uncertain();
    if (method === 'DELETE') {
      if (response.status === 204 || (response.status === 200 && await response.text().catch(() => null) === '')) return;
      throw uncertain();
    }
    try {
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw unreadable();
      return data;
    } catch {
      throw writing ? uncertain() : unreadable();
    }
  }

  async function* pages(path, params, kind) {
    const seen = new Set();
    for (;;) {
      const page = await request(path, { params });
      if (!Array.isArray(page.items) && !(page.items === undefined && (page.kind === kind || page.nextPageToken))) throw unreadable();
      yield page;
      const next = page.nextPageToken;
      if (next === undefined) return;
      if (typeof next !== 'string' || !next || seen.has(next)) throw unreadable();
      seen.add(next);
      params = { ...params, pageToken: next };
    }
  }

  function confirmed(raw, source, id) {
    if (raw.id !== id || raw.status === 'cancelled' || !hasVersion(raw.etag)) throw uncertain();
    try {
      return eventItem(raw, source, timeZone, source.accessRole);
    } catch {
      throw uncertain();
    }
  }

  return {
    async sources() {
      const list = new Map();
      for await (const page of pages('users/me/calendarList', { maxResults: '250', showHidden: 'true' }, 'calendar#calendarList')) {
        for (const raw of page.items || []) {
          identifier(raw.id);
          if (raw.deleted || raw.accessRole === 'none') {
            list.delete(raw.id);
            continue;
          }
          list.set(raw.id, {
            id: raw.id, name: raw.summaryOverride || raw.summary || raw.id, writable: writeRoles.has(raw.accessRole),
            accessRole: raw.accessRole, primary: raw.primary === true,
            ...(raw.backgroundColor ? { color: raw.backgroundColor } : {}),
            ...(raw.timeZone ? { timeZone: raw.timeZone } : {}),
          });
        }
      }
      return [...list.values()];
    },

    async items(source, start, end) {
      const range = windowFor(start, end, timeZone, source.timeZone);
      const list = new Map();
      const params = { timeMin: range.timeMin, timeMax: range.timeMax, timeZone, singleEvents: 'true', showDeleted: 'false', maxResults: '2500' };
      for await (const page of pages(events(source), params, 'calendar#events')) {
        for (const raw of page.items || []) {
          if (raw.status === 'cancelled') {
            list.delete(raw.id);
            continue;
          }
          const item = eventItem(raw, source, timeZone, page.accessRole || source.accessRole);
          if (inWindow(item, range)) list.set(item.id, item);
          else list.delete(item.id);
        }
      }
      return [...list.values()];
    },

    async create(source, draft) {
      requireCalendar(source);
      const fields = eventFields(draft, null, timeZone);
      const id = draft.operationId
        ? createHash('sha256').update(draft.operationId).digest('hex').slice(0, 32)
        : randomUUID().replaceAll('-', '');
      try {
        const resource = await request(events(source), { method: 'POST', body: { id, ...fields }, params: { sendUpdates: 'none' } });
        return confirmed(resource, source, id);
      } catch (failure) {
        if (failure.code === 'CONFLICT' && failure.status === 409) failure = uncertain();
        if (failure.code === 'UNCERTAIN') failure.providerId = id;
        throw failure;
      }
    },

    async update(source, original, draft) {
      reviewChange(source, original, draft, 'canEdit');
      const body = eventFields(draft, original, timeZone);
      if (!Object.keys(body).length) return original;
      const path = events(source) + '/' + identifier(original.id);
      const params = { sendUpdates: draft.notify === true ? 'all' : 'none' };
      const resource = await request(path, { method: 'PATCH', body, version: original.version, params });
      return confirmed(resource, source, original.id);
    },

    async remove(source, original, options = {}) {
      reviewChange(source, original, options, 'canDelete');
      const path = events(source) + '/' + identifier(original.id);
      const params = { sendUpdates: options.notify === true ? 'all' : 'none' };
      await request(path, { method: 'DELETE', version: original.version, params });
    },
  };
}
