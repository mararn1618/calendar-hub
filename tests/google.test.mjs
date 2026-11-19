import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { authorizeGoogle, createGoogle, refreshGoogleToken } from '../desktop/providers/google.mjs';

const source = { id: 'appointments+test@example.test', writable: true, accessRole: 'owner' };
const event = {
  id: 'appointment', etag: '"v1"', summary: 'Dentist', organizer: { self: true },
  start: { dateTime: '2026-03-29T10:00:00+02:00', timeZone: 'Europe/Berlin' },
  end: { dateTime: '2026-03-29T11:00:00+02:00', timeZone: 'Europe/Berlin' },
};
const days = ['2026-03-29', '2026-03-30'];
const allDay = { title: 'Holiday', start: days[0], end: days[1], allDay: true };

function fixture(serve, timeZone = 'Europe/Berlin') {
  const calls = [];
  const google = createGoogle({
    timeZone, apiBase: 'http://127.0.0.1/calendar/v3/', getAccessToken: async () => 'fixture',
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const call = { url, method: init.method, headers: new Headers(init.headers), body: init.body && JSON.parse(init.body) };
      calls.push(call);
      assert.equal(call.headers.get('authorization'), 'Bearer fixture');
      assert.equal(init.redirect, 'error');
      return serve(call);
    },
  });
  return { google, calls };
}

test('discovers writable and read-only calendars, including hidden and paged entries', async () => {
  const { google, calls } = fixture(({ url }) => {
    assert.equal(url.pathname, '/calendar/v3/users/me/calendarList');
    assert.equal(url.searchParams.get('showHidden'), 'true');
    if (url.searchParams.has('pageToken')) return Response.json({ items: [
      { id: 'bmw', summary: 'BMW', summaryOverride: 'Work', accessRole: 'reader', backgroundColor: '#123456' },
      { id: 'gone', deleted: true }, { id: 'blocked', accessRole: 'none' },
    ] });
    return Response.json({ items: [{ ...source, primary: true, summary: 'Personal' }], nextPageToken: 'next' });
  });
  const available = await google.sources();
  assert.deepEqual(available.map(item => [item.id, item.name, item.writable]), [[source.id, 'Personal', true], ['bmw', 'Work', false]]);
  assert.equal(available[0].primary, true);
  assert.equal(available[1].color, '#123456');
  assert.equal(calls.length, 2);
});

test('reads every event page, filters cancellations, and uses a 23-hour local day', async () => {
  const { google } = fixture(({ url }) => {
    assert.equal(url.pathname, '/calendar/v3/calendars/appointments%2Btest%40example.test/events');
    assert.equal(url.searchParams.get('timeMin'), '2026-03-28T23:00:00.000Z');
    assert.equal(url.searchParams.get('timeMax'), '2026-03-29T22:00:00.000Z');
    assert.equal(url.searchParams.get('timeZone'), 'Europe/Berlin');
    assert.equal(url.searchParams.get('singleEvents'), 'true');
    if (!url.searchParams.has('pageToken')) return Response.json({ items: [{ ...event, id: 'obsolete' }], nextPageToken: 'page' });
    return Response.json({ items: [
      { ...event, start: { dateTime: '2026-03-29T03:30:00', timeZone: 'Europe/Berlin' }, description: 'private notes', conferenceData: { secret: '123' } },
      { ...event, id: 'holiday', start: { date: days[0] }, end: { date: days[1] } },
      { id: 'obsolete', status: 'cancelled' },
    ] });
  });
  const [timed, holiday, ...rest] = await google.items(source, ...days);
  assert.equal(timed.start, '2026-03-29T01:30:00.000Z');
  assert.equal(timed.end, '2026-03-29T09:00:00.000Z');
  assert.equal(timed.canEdit, true);
  assert.equal(timed.canDelete, true);
  assert.equal(timed.canComplete, false);
  assert.equal(timed.completed, false);
  assert.equal(timed.description, undefined);
  assert.equal(timed.conferenceData, undefined);
  assert.equal(holiday.allDay, true);
  assert.equal(holiday.start, days[0]);
  assert.equal(holiday.end, days[1]);
  assert.deepEqual(rest, []);
});

test('reads all-day dates across the date line without including timed events from tomorrow', async () => {
  const { google } = fixture(({ url }) => {
    assert.equal(url.searchParams.get('timeMin'), '2026-03-28T10:00:00.000Z');
    assert.equal(url.searchParams.get('timeMax'), '2026-03-30T10:00:00.000Z');
    return Response.json({ items: [
      { ...event, id: 'holiday', start: { date: days[0] }, end: { date: days[1] } },
      { ...event, id: 'tomorrow', start: { dateTime: '2026-03-29T11:00:00Z' }, end: { dateTime: '2026-03-29T12:00:00Z' } },
    ] });
  }, 'Pacific/Kiritimati');
  const items = await google.items({ ...source, timeZone: 'Pacific/Honolulu' }, ...days);
  assert.deepEqual(items.map(item => item.id), ['holiday']);
});

test('fails the whole refresh if a page fails or the continuation token repeats', async () => {
  for (const next of [new Response(null, { status: 500 }), Response.json({ items: [], nextPageToken: 'loop' })]) {
    const { google, calls } = fixture(({ url }) => url.searchParams.has('pageToken')
      ? next : Response.json({ items: [event], nextPageToken: 'loop' }));
    await assert.rejects(google.items(source, ...days), { code: 'PROVIDER' });
    assert.equal(calls.length, 2);
  }
});

test('enforces calendar, organizer, guest, privacy and event-type permissions', async () => {
  const rows = [
    { id: 'own' }, { id: 'guest', organizer: {}, attendees: [{ self: true }] },
    { id: 'guest-can-edit', organizer: { self: false }, attendees: [{ self: true }], guestsCanModify: true },
    { id: 'secret', visibility: 'private' }, { id: 'lock', locked: true }, { id: 'special', eventType: 'fromGmail' },
    { id: 'master', recurrence: ['RRULE:FREQ=DAILY'] }, { id: 'weak-tag', etag: '*' },
    { id: 'missing-owner', organizer: undefined },
  ].map(entry => ({ ...event, ...entry }));
  const { google, calls } = fixture(() => Response.json({ accessRole: 'writerWithoutPrivateAccess', items: rows }));
  const items = await google.items(source, ...days);
  assert.deepEqual(items.filter(item => item.canEdit).map(item => item.id), ['own', 'guest-can-edit']);
  assert.deepEqual(items.filter(item => item.canDelete).map(item => item.id), ['own']);
  assert.ok(items.find(item => item.id === 'guest-can-edit').hasAttendees);
  for (const item of items.filter(row => !row.canEdit)) {
    await assert.rejects(google.update(source, item, { ...item, title: 'Changed' }), { code: 'READ_ONLY' });
  }
  await assert.rejects(google.remove(source, items[2], { notify: true }), { code: 'READ_ONLY' });
  const readOnly = { ...source, writable: false };
  const locked = await google.items(readOnly, ...days);
  assert.ok(locked.every(item => !item.canEdit && !item.canDelete));
  await assert.rejects(google.create(readOnly, allDay), { code: 'READ_ONLY' });
  await assert.rejects(google.remove({ ...source, id: 'other-calendar' }, items[0]), { code: 'INVALID' });
  assert.equal(calls.length, 2);
});

test('patches only edited fields on the reviewed instance, sends guest updates and checks the exact version', async () => {
  let stored = {
    ...event, id: 'series_20260329', recurringEventId: 'series',
    originalStartTime: event.start, attendees: [{ email: 'guest@example.test' }],
    location: 'Room A', description: 'Keep', conferenceData: { conferenceId: 'keep' }, reminders: { useDefault: true },
  };
  const { google, calls } = fixture(({ method, url, headers, body }) => {
    if (method === 'GET') return Response.json({ items: [stored] });
    assert.ok(url.pathname.endsWith('/events/series_20260329'));
    assert.equal(url.searchParams.get('sendUpdates'), 'all');
    if (headers.get('if-match') !== stored.etag) return new Response(null, { status: 412 });
    if (method === 'DELETE') {
      stored = null;
      return new Response(null, { status: 204 });
    }
    assert.equal(method, 'PATCH');
    assert.deepEqual(body, { end: { dateTime: '2026-03-29T10:00:00.000Z' } });
    stored = { ...stored, end: { ...stored.end, ...body.end }, etag: '"v2"' };
    return Response.json(stored);
  });
  const [original] = await google.items(source, ...days);
  const edit = { ...original, end: '2026-03-29T12:00:00+02:00' };
  await assert.rejects(google.update(source, original, { ...edit, notify: true }), { code: 'REVIEW_REQUIRED' });
  await assert.rejects(google.update(source, original, { ...edit, occurrence: true }), { code: 'REVIEW_REQUIRED' });
  await assert.rejects(google.remove(source, original, { notify: true, occurrence: 'series' }), { code: 'REVIEW_REQUIRED' });
  assert.equal(calls.length, 1);
  const confirmed = await google.update(source, original, { ...edit, notify: true, occurrence: true });
  assert.equal(confirmed.version, '"v2"');
  assert.equal(stored.description, 'Keep');
  assert.equal(stored.conferenceData.conferenceId, 'keep');
  assert.equal(stored.end.timeZone, event.end.timeZone);
  await assert.rejects(google.update(source, original, { ...edit, notify: true, occurrence: true }), { code: 'CONFLICT' });
  await assert.rejects(google.remove(source, original, { notify: true, occurrence: true }), { code: 'CONFLICT' });
  await google.remove(source, confirmed, { notify: true, occurrence: true });
  assert.equal(stored, null);
});

test('creates all-day and timed events with client IDs, and clears former date fields during conversions', async () => {
  let stored;
  const { google, calls } = fixture(({ method, body }) => {
    if (method === 'POST') {
      assert.match(body.id, /^[a-v0-9]{32}$/);
      stored = { ...body, etag: '"new"', organizer: { self: true } };
    } else {
      for (const key of ['start', 'end']) {
        for (const [field, value] of Object.entries(body[key])) {
          if (value === null) delete stored[key][field];
          else stored[key][field] = value;
        }
      }
      stored.etag = '"updated"';
    }
    return Response.json(stored);
  });
  const day = await google.create(source, allDay);
  assert.equal(day.allDay, true);
  assert.deepEqual(stored.start, { date: days[0] });
  assert.deepEqual(stored.end, { date: days[1] });
  const timed = { title: allDay.title, allDay: false, start: '2026-03-29T08:00:00Z', end: '2026-03-29T09:00:00Z' };
  const scheduled = await google.update(source, day, timed);
  assert.equal(scheduled.allDay, false);
  assert.deepEqual(stored.start, { dateTime: '2026-03-29T08:00:00.000Z', timeZone: 'Europe/Berlin' });
  await google.update(source, scheduled, allDay);
  assert.deepEqual(stored.start, { date: days[0] });
  const appointment = await google.create(source, timed);
  assert.notEqual(appointment.id, day.id);
  assert.equal(appointment.start, '2026-03-29T08:00:00.000Z');
  await assert.rejects(google.create(source, { ...allDay, end: days[0] }), { code: 'INVALID_DATE' });
  await assert.rejects(google.create(source, { ...allDay, start: '2026-02-30' }), { code: 'INVALID_DATE' });
  assert.equal(calls.length, 4);
});

test('reports unclear create outcomes with the same remote ID for a persisted operation', async () => {
  const responses = [
    () => { throw new Error('socket closed'); }, () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 202 }), () => Response.json({}), () => new Response('{'),
    () => new Response(null, { status: 409 }), () => Response.json(event),
  ];
  let firstId;
  for (const respond of responses) {
    const { google, calls } = fixture(respond);
    await assert.rejects(google.create(source, { ...allDay, operationId: 'same-request' }), failure => {
      assert.equal(failure.code, 'UNCERTAIN');
      assert.match(failure.providerId, /^[0-9a-f]{32}$/);
      firstId ??= failure.providerId;
      assert.equal(failure.providerId, firstId);
      return true;
    });
    assert.equal(calls.length, 1);
  }
  const { google } = fixture(() => new Response(null, { status: 400 }));
  await assert.rejects(google.create(source, allDay), { code: 'PROVIDER' });
});

test('desktop OAuth signs in through loopback using state and PKCE, then refreshes offline', async () => {
  let redirect, challenge, granted, browserResponse;
  const fetchToken = async (endpoint, { method, body }) => {
    assert.equal(endpoint, 'http://127.0.0.1/fixture-token');
    assert.equal(method, 'POST');
    assert.equal(body.get('client_id'), 'desktop');
    assert.equal(body.get('client_secret'), 'local-client-secret');
    if (body.get('grant_type') === 'refresh_token') {
      assert.equal(body.get('refresh_token'), 'fixture-refresh');
      return Response.json({ access_token: 'renewed', expires_in: 3000 });
    }
    assert.equal(body.get('redirect_uri'), redirect);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'callback-code');
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge);
    return Response.json({ access_token: 'fresh', expires_in: 3600, refresh_token: 'fixture-refresh', scope: granted });
  };
  const client = { clientId: 'desktop', clientSecret: 'local-client-secret', fetchImpl: fetchToken, tokenEndpoint: 'http://127.0.0.1/fixture-token' };
  const tokens = await authorizeGoogle({
    ...client, timeoutMs: 3000, authEndpoint: 'http://127.0.0.1/fixture-consent',
    openExternal: async input => {
      const url = new URL(input);
      assert.equal(url.pathname, '/fixture-consent');
      assert.equal(url.searchParams.get('client_secret'), null);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('access_type'), 'offline');
      challenge = url.searchParams.get('code_challenge');
      granted = url.searchParams.get('scope');
      redirect = url.searchParams.get('redirect_uri');
      assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      const callback = new URL(redirect);
      callback.search = new URLSearchParams({ state: 'incorrect', code: 'wrong' });
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('code', 'callback-code');
      browserResponse = fetch(callback);
      assert.equal((await browserResponse).status, 200);
    },
  });
  assert.equal((await browserResponse).status, 200);
  assert.equal(tokens.refreshToken, 'fixture-refresh');
  assert.equal(tokens.accessToken, 'fresh');
  assert.ok(tokens.expiresAt > Date.now() + 3_590_000);
  const refreshed = await refreshGoogleToken({ ...client, refreshToken: tokens.refreshToken });
  assert.deepEqual(Object.keys(refreshed).sort(), ['accessToken', 'expiresAt']);
  assert.equal(refreshed.accessToken, 'renewed');
  assert.ok(refreshed.expiresAt > Date.now() + 2_990_000);
});

test('handles consent cancellation, a closed browser and a revoked refresh token', async () => {
  let callback;
  const client = { clientId: 'desktop', timeoutMs: 1000, fetchImpl: () => assert.fail('Unexpected token exchange') };
  await assert.rejects(authorizeGoogle({
    ...client, openExternal: async input => {
      const url = new URL(input);
      const address = new URL(url.searchParams.get('redirect_uri'));
      address.search = new URLSearchParams({ state: url.searchParams.get('state'), error: 'access_denied' });
      callback = fetch(address);
      await callback;
    },
  }), /cancelled/);
  assert.equal((await callback).status, 400);
  await assert.rejects(authorizeGoogle({ ...client, timeoutMs: 25, openExternal() {} }), /timed out/);
  await assert.rejects(refreshGoogleToken({
    ...client, refreshToken: 'old', fetchImpl: () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
  }), { code: 'AUTH_REQUIRED' });
});
