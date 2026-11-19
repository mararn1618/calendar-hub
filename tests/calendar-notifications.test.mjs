import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalendarService } from '../desktop/calendar-service.mjs';

const now = Date.parse('2026-11-19T12:00Z');
const unrelated = { start: '2030-02-01', end: '2030-02-02' };
const list = (id, extra = {}) => ({ id, name: id, writable: true, ...extra });
const item = (id, start, extra = {}) => ({ id, title: id, start, end: start, allDay: false, version: 'v1',
  canComplete: true, canEdit: true, canDelete: true, ...extra });

function workspace(t, current = now) {
  t.mock.timers.enable({ apis: ['Date'], now: current });
  const profile = { data: { sources: [], connections: [], hidden: [], journal: [], cache: {} },
    seal: secret => secret, open: connection => connection.secret, save() {} };
  const calendars = { ticktick: [list('studio'), list('home')], google: [list('work'), list('personal')], mac: [list('meetings')] };
  const rows = new Map(), offline = new Set(), errors = new Map(), reads = [], discoveries = [];
  const center = { status: 'undetermined', decision: 'allowed', checks: 0, prompts: 0, queue: [], replacements: 0,
    async authorization() { this.checks++; return this.status; },
    async requestAuthorization() { this.prompts++; this.status = this.decision; return this.status; },
    async replace(requests) {
      this.replacements++;
      if (this.broken) throw new Error('System notification service offline.');
      this.queue = structuredClone(requests);
    } };
  const providers = { notificationCenter: center, authorize: async () => ({}), identity: provider => provider,
    client(provider) {
      return {
        sources: async () => {
          discoveries.push(provider);
          if (errors.has(provider)) throw errors.get(provider);
          if (offline.has(provider)) throw new Error('Directory offline');
          return structuredClone(calendars[provider]);
        },
        items: async (source, start, end) => {
          reads.push({ id: source.id, start, end });
          if (errors.has(source.id)) throw errors.get(source.id);
          if (offline.has(source.id)) throw new Error('Source offline');
          const from = Date.parse(start + 'T00:00:00'), until = Date.parse(end + 'T00:00:00');
          return structuredClone((rows.get(source.id) ?? []).filter(row => !row.start ||
            (Date.parse(row.start) >= from && Date.parse(row.start) < until)));
        },
        async update(source, original, draft) {
          const saved = { ...original, ...draft, version: 'v2' };
          rows.set(source.id, rows.get(source.id).map(row => row.id === original.id ? saved : row));
          return saved;
        },
        async complete(source, original) {
          rows.set(source.id, rows.get(source.id).map(row => row.id === original.id ? { ...row, completed: true } : row));
        },
        async remove(source, original) { rows.set(source.id, rows.get(source.id).filter(row => row.id !== original.id)); },
      };
    } };
  let service = new CalendarService(profile, providers);
  const run = (method, input) => service.run(method, input);
  const restart = () => { profile.data = structuredClone(profile.data); service = new CalendarService(profile, providers); };
  const connect = provider => run('connect', { provider });
  const bell = (calendarId, enabled, leadMinutes) => run('setCalendarNotifications', { calendarId, enabled, leadMinutes });
  const queue = () => Object.fromEntries(center.queue.map(reminder => [reminder.title, reminder.fireAt]));
  const view = () => run('state', { ...unrelated, preferencesOnly: true });
  return { profile, center, reads, discoveries, rows, calendars, offline, errors, connect, restart, bell, queue, view, run };
}

test('Mac permission recovery refreshes hidden reminders and cached events without calling a limited provider', async t => {
  const { connect, run, view, bell, rows, reads, discoveries, errors, queue } = workspace(t);
  await connect('mac');
  await connect('ticktick');
  const mac = (await view()).sources.find(source => source.provider === 'mac');
  await run('setSource', { sourceId: mac.id, selected: true });
  const window = { start: '2026-11-19', end: '2026-11-20' };
  rows.set('meetings', [item('meeting', '2026-11-19T13:00:00Z')]);
  await bell(mac.id, true, 10);
  await run('state', window);
  const denied = Object.assign(new Error('Full calendar access is required.'), { code: 'CALENDAR_ACCESS' });
  const limited = Object.assign(new Error('TickTick reached its request limit.'), { code: 'RATE_LIMITED', status: 429 });
  for (const id of ['mac', 'meetings']) errors.set(id, denied);
  for (const id of ['ticktick', 'studio', 'home']) errors.set(id, limited);
  const stale = await run('state', { ...window, refreshNotifications: true });
  assert(stale.items.some(row => row.title === 'meeting'));
  assert(stale.health.some(entry => entry.sourceId === mac.id && entry.state === 'stale' && entry.code === denied.code));
  assert(stale.health.some(entry => !entry.sourceId && entry.status === 429 && entry.code === limited.code));
  assert(stale.notificationFailures.some(entry => entry.code === denied.code && entry.sourceId === mac.id));
  assert.equal(stale.notificationError, null);
  assert.deepEqual(queue(), { meeting: '2026-11-19T12:50:00.000Z' });
  await run('setSource', { sourceId: mac.id, selected: false });
  rows.set('meetings', [item('moved', '2026-11-19T15:00:00Z')]);
  for (const id of ['mac', 'meetings']) errors.delete(id);
  reads.length = discoveries.length = 0;
  const recovered = await run('state', { ...window, macOnly: true, refreshNotifications: true });
  assert.deepEqual(discoveries, ['mac']);
  assert.deepEqual(reads.map(row => row.id), ['meetings']);
  assert.deepEqual(recovered.notificationFailures, []);
  assert(recovered.health.some(entry => entry.status === 429));
  assert.deepEqual(queue(), { moved: '2026-11-19T14:50:00.000Z' });
});

test('checking Mac access preserves a newer TickTick reminder failure outside the timeline refresh', async t => {
  const { connect, run, view, bell, errors, reads } = workspace(t);
  await connect('mac');
  await connect('ticktick');
  const calendar = (await view()).ticktickCalendars[0];
  await bell(calendar.id, true, 0);
  const range = { start: '2026-11-19', end: '2026-11-28' };
  await run('state', range);
  errors.set('studio', Object.assign(new Error('TickTick reached its request limit.'), { code: 'RATE_LIMITED', status: 429 }));
  await run('refreshNotifications');
  const failures = (await run('state', { ...range, cachedOnly: true })).notificationFailures;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].status, 429);
  reads.length = 0;
  const checked = await run('state', { ...range, macOnly: true, refreshNotifications: true });
  assert.deepEqual(checked.notificationFailures, failures);
  assert.deepEqual(reads, []);
});

test('reminders default to muted and ask for permission only on an explicit enable', async t => {
  const { connect, view, run, center, reads, discoveries, bell, restart } = workspace(t);
  await connect('google');
  const initial = await view();
  const calendar = initial.sources[0].id;
  assert.deepEqual(initial.notificationPreferences[calendar], { enabled: false, leadMinutes: 10 });
  await run('refreshNotifications');
  assert.deepEqual(discoveries, ['google']);
  assert.deepEqual(reads, []);
  await bell(calendar, undefined, 42);
  restart();
  assert.deepEqual((await view()).notificationPreferences[calendar], { enabled: false, leadMinutes: 42 });
  assert.deepEqual([center.checks, center.prompts, center.replacements], [0, 0, 0]);
  for (const minutes of [-1, 10081, 1.5, '0']) await assert.rejects(bell(calendar, true, minutes), /whole minutes/);
  await assert.rejects(bell('another-source', true), /available calendar/);
  center.decision = 'denied';
  await assert.rejects(bell(calendar, true, 0), /System Settings.*Notifications.*Allow Notifications/);
  assert.deepEqual((await view()).notificationPreferences[calendar], { enabled: false, leadMinutes: 42 });
  assert.equal(center.prompts, 1);
  await assert.rejects(bell(calendar, true), /Allow Notifications/);
  center.status = 'allowed';
  await bell(calendar, true, 0);
  assert.deepEqual((await view()).notificationPreferences[calendar], { enabled: true, leadMinutes: 0 });
  assert.deepEqual(reads.map(read => read.id), ['work']);
  center.status = 'denied';
  await run('refreshNotifications');
  assert.match((await view()).notificationError, /System Settings.*Notifications/);
  assert.equal(center.prompts, 1);
});

test('timed reminders use civil provider dates across DST and a seven-day fire window with the selected lead', async t => {
  const oldZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; });
  const { connect, view, rows, bell, reads, queue, center, run } = workspace(t, Date.parse('2026-10-30T16:00Z'));
  await connect('google');
  const calendar = (await view()).sources[0].id;
  rows.set('work', [item('right edge', '2026-11-13T17:00:00Z'), item('last minute', '2026-11-13T16:59:00Z'),
    item('first minute', '2026-11-06T16:01:00Z'), item('already due', '2026-11-06T16:00:00Z'),
    item('finished', '2026-11-08T12:00Z', { completed: true }), item('removed', '2026-11-08T12:00Z', { status: 'cancelled' }),
    item('all day', '2026-11-08', { allDay: true }), item('undated', undefined)]);
  await bell(calendar, true, 10080);
  assert.deepEqual(reads, [{ id: 'work', start: '2026-11-06', end: '2026-11-14' }]);
  assert.deepEqual(queue(), { 'first minute': '2026-10-30T16:01:00.000Z', 'last minute': '2026-11-06T16:59:00.000Z' });
  assert(center.queue.every(request => request.body.includes('work')));

  rows.set('work', [item('first 1:30', '2026-11-01T01:30:00-04:00'), item('second 1:30', '2026-11-01T01:30:00-05:00')]);
  await bell(calendar, undefined, 0);
  await run('state', { ...unrelated, refreshNotifications: true });
  assert.deepEqual(queue(), { 'first 1:30': '2026-11-01T05:30:00.000Z', 'second 1:30': '2026-11-01T06:30:00.000Z' });
  assert.deepEqual(Object.keys(center.queue[0]).sort(), ['body', 'fireAt', 'id', 'title']);
});

test('enabling a bell rereads that calendar even after a successful recent week view and on re-enable', async t => {
  const { connect, view, rows, reads, queue, run, bell } = workspace(t);
  await connect('ticktick');
  await connect('google');
  const { ticktickCalendars: [account], sources } = await view();
  const work = sources.find(source => source.name === 'work');
  await bell(work.id, true);
  await run('state', { start: '2026-11-16', end: '2026-12-01' });
  rows.set('home', [item('new task', '2026-11-20T14:00Z')]);
  reads.length = 0;
  await bell(account.id, true);
  assert.deepEqual(reads.map(read => read.id), ['studio', 'home']);
  assert.deepEqual(queue(), { 'new task': '2026-11-20T13:50:00.000Z' });
  reads.length = 0;
  await bell(account.id, false);
  assert.deepEqual(reads, []);
  rows.set('studio', [item('another task', '2026-11-20T17:00Z')]);
  await bell(account.id, true);
  assert.deepEqual(reads.map(read => read.id), ['studio', 'home']);
  assert.deepEqual(queue(), { 'new task': '2026-11-20T13:50:00.000Z', 'another task': '2026-11-20T16:50:00.000Z' });
});

test('TickTick notifications follow inclusion, grouping and renames independently of sidebar visibility', async t => {
  const { connect, view, rows, center, queue, run, restart, reads, bell, profile } = workspace(t);
  await connect('ticktick');
  const { ticktickCalendars: [account], sources, connections: [{ id: connectionId }] } = await view();
  const studio = sources.find(source => source.name === 'studio').id;
  rows.set('studio', [item('Review', '2026-11-20T16:00Z')]);
  rows.set('home', [item('Shopping', '2026-11-20T17:00Z')]);
  await bell(account.id, true);
  const firstId = center.queue[0].id;
  await run('setTickTickCalendarVisible', { connectionId, calendarId: account.id, visible: false });
  assert.deepEqual(Object.keys(queue()), ['Review', 'Shopping']);
  await run('configureTickTick', { connectionId, includedSourceIds: [studio] });
  assert.deepEqual(queue(), { Review: '2026-11-20T15:50:00.000Z' });
  await run('configureTickTick', { connectionId, mode: 'custom', groups: [{ id: 'work', name: 'Work', sourceIds: [studio] }] });
  assert.deepEqual(queue(), {});
  const [custom] = (await view()).ticktickCalendars;
  await assert.rejects(bell(studio, true), /available calendar/);
  await bell(custom.id, true, 30);
  assert.equal(center.queue[0].id, firstId);
  await run('configureTickTick', { connectionId, groups: [{ id: 'work', name: 'Studio projects', sourceIds: [studio] }] });
  assert.match(center.queue[0].body, /Studio projects/);
  restart();
  await run('refreshNotifications');
  assert.deepEqual(queue(), { Review: '2026-11-20T15:30:00.000Z' });
  assert.equal(center.prompts, 1);
  await run('configureTickTick', { connectionId, mode: 'account' });
  assert.equal((await view()).ticktickCalendars[0].visible, false);
  assert.deepEqual(queue(), { Review: '2026-11-20T15:50:00.000Z' });
  const calls = reads.length;
  await run('disconnect', { connectionId });
  assert.deepEqual(queue(), {});
  assert.deepEqual(profile.data.notificationPreferences, {});
  assert.equal(reads.length, calls);
});

test('a TickTick reminder outage gives one warning for the calendar and clears after recovery', async t => {
  const { calendars, offline, connect, view, bell, run } = workspace(t);
  calendars.ticktick = Array.from({ length: 54 }, (_, index) => list('Private list ' + (index + 1)));
  await connect('ticktick');
  const [account] = (await view()).ticktickCalendars;
  for (const source of calendars.ticktick) offline.add(source.id);
  await bell(account.id, true);
  const message = (await view()).notificationError;
  assert.match(message, /1 calendar\b/);
  assert.equal(message.match(/Source offline/g)?.length, 1);
  assert.doesNotMatch(message, /Private list/);
  offline.clear();
  await run('refreshNotifications');
  assert.equal((await view()).notificationError, null);
});

test('offline sources keep future notices while other calendars update, mute or expire', async t => {
  const { connect, view, center, queue, rows, reads, offline, run, bell, restart } = workspace(t);
  await connect('google');
  const { sources: [work, personal] } = await view();
  rows.set('work', [item('meeting', '2026-11-20T18:00Z'), item('deleted remotely', '2026-11-20T19:00Z')]);
  rows.set('personal', [item('call', '2026-11-20T15:00Z')]);
  await bell(work.id, true, 0);
  await bell(personal.id, true, 15);
  const ids = new Map(center.queue.map(row => [row.title, row.id]));
  offline.add('personal');
  rows.set('work', [item('meeting', '2026-11-20T20:00Z')]);
  await run('refreshNotifications');
  await run('refreshNotifications');
  assert.deepEqual(queue(), { call: '2026-11-20T14:45:00.000Z', meeting: '2026-11-20T20:00:00.000Z' });
  assert(center.queue.every(row => ids.get(row.title) === row.id));
  assert.match((await view()).notificationError, /Source offline/);
  restart();
  await run('refreshNotifications');
  assert.equal(center.queue.length, 2);
  const calls = reads.length;
  await bell(work.id, false);
  assert.equal(reads.length, calls);
  assert.deepEqual(queue(), { call: '2026-11-20T14:45:00.000Z' });
  t.mock.timers.tick(27 * 60 * 60_000);
  await run('refreshNotifications');
  assert.deepEqual(queue(), {});
  offline.delete('personal');
  await run('refreshNotifications');
  assert.equal((await view()).notificationError, null);
});

test('confirmed item edits, completion and deletion update local reminders without waiting on provider reads', async t => {
  const { connect, run, view, rows, queue, reads, offline, bell } = workspace(t);
  await connect('ticktick');
  await connect('google');
  const { ticktickCalendars: [account], sources } = await view();
  const work = sources.find(source => source.name === 'work');
  rows.set('studio', [item('task', '2026-11-20T14:00Z')]);
  rows.set('work', [item('event', '2026-11-20T16:00Z')]);
  await run('setSource', { sourceId: work.id, selected: true });
  await bell(account.id, true, 10);
  await bell(work.id, true, 5);
  const day = { start: '2026-11-20', end: '2026-11-21' };
  const loaded = await run('state', day);
  const task = loaded.items.find(entry => entry.id === 'task'), event = loaded.items.find(entry => entry.id === 'event');
  const before = reads.length;
  offline.add('studio');
  await run('save', { ...task, start: '2026-11-20T18:00Z', end: '2026-11-20T18:30Z' });
  assert.deepEqual(queue(), { event: '2026-11-20T15:55:00.000Z', task: '2026-11-20T17:50:00.000Z' });
  await run('complete', { ...task, version: 'v2' });
  await run('remove', event);
  assert.deepEqual(queue(), {});
  assert.equal(reads.length, before);
  await run('refreshNotifications');
  assert.deepEqual(queue(), {});
});

test('a task found in a new TickTick list replaces the offline former list reminder and respects its new bell', async t => {
  const { connect, view, run, rows, bell, queue, center, offline, restart } = workspace(t);
  await connect('ticktick');
  const { sources: [studio, home], connections: [{ id: connectionId }] } = await view();
  await run('configureTickTick', { connectionId, mode: 'custom', groups: [
    { id: 'studio', name: 'Studio', sourceIds: [studio.id] }, { id: 'home', name: 'Home', sourceIds: [home.id] },
  ] });
  const [studioCalendar, homeCalendar] = (await view()).ticktickCalendars;
  rows.set('home', [item('original task', '2026-11-20T15:00Z')]);
  await bell(studioCalendar.id, true, 30);
  await bell(homeCalendar.id, true, 10);
  const originalId = center.queue[0].id;
  assert.deepEqual(queue(), { 'original task': '2026-11-20T14:50:00.000Z' });
  offline.add('home');
  rows.set('home', []);
  rows.set('studio', [item('original task', '2026-11-20T18:00Z')]);
  await run('refreshNotifications');
  assert.deepEqual(queue(), { 'original task': '2026-11-20T17:30:00.000Z' });
  assert.deepEqual(center.queue.map(request => request.id), [originalId]);
  await bell(studioCalendar.id, false);
  assert.deepEqual(queue(), {});
  restart();
  await run('refreshNotifications');
  assert.deepEqual(queue(), {});
});

test('a failed native cancellation is retried after restart even with all bells muted', async t => {
  const { connect, view, center, rows, queue, run, bell, restart, profile, reads } = workspace(t);
  await connect('mac');
  const [calendar] = (await view()).sources;
  rows.set('meetings', [item('meeting', '2026-11-20T18:00Z')]);
  await bell(calendar.id, true);
  center.broken = true;
  await bell(calendar.id, false);
  assert.equal(profile.data.notificationRequestsPending, true);
  assert.match((await view()).notificationError, /System notification service offline/);
  const calls = reads.length;
  center.broken = false;
  restart();
  await run('refreshNotifications');
  assert.deepEqual(queue(), {});
  assert.equal(reads.length, calls);
  assert.equal(profile.data.notificationRequestsPending, false);
});
