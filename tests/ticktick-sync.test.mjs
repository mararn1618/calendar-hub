import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalendarService } from '../desktop/calendar-service.mjs';

const minute = 60_000;
const now = Date.parse('2026-11-19T12:00Z');
const days = { start: '2026-11-19', end: '2026-11-22' };
const list = id => ({ id, name: id, writable: true });
const allDay = (id, start, end) => ({ id, title: id, start, end, allDay: true, canEdit: true, canComplete: true, version: '1' });
const overlaps = (row, start, end) => row.allDay ? row.start < end && row.end > start :
  Date.parse(row.start) < +new Date(end + 'T00:00:00') && Date.parse(row.end) >= +new Date(start + 'T00:00:00');

function workspace(t) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const opened = [];
  const profile = { data: { sources: [], connections: [], cache: {}, hidden: [], journal: [] },
    save() {}, seal: value => value, open(connection) { opened.push(connection.name); return connection.secret; } };
  const lists = new Map(), rows = new Map(), calls = [], failures = new Map();
  const center = { requests: [], replacements: 0, authorization: async () => 'allowed', async replace(rows) { this.requests = rows; this.replacements++; } };
  const providers = {
    notificationCenter: center, authorize: async ({ name }) => ({ name }), identity: (_provider, { name }) => name,
    client(provider, { name }) {
      const attempt = (kind, fields) => {
        const entry = { name, kind, ...fields };
        calls.push(entry);
        const failed = failures.get(name)?.(entry);
        if (failed) throw failed;
      };
      const sources = async () => { attempt('directory'); return structuredClone(lists.get(name)); };
      if (provider !== 'ticktick') return { sources, items: async () => { attempt('events'); return []; } };
      return {
        sources, items: () => assert.fail('A calendar read scanned a whole TickTick list'),
        async itemsForSources(selected, start, end) {
          attempt('tasks', { ids: selected.map(source => source.id), start, end });
          return new Map(selected.map(({ id }) => [id, structuredClone((rows.get(name + '/' + id) ?? [])
            .filter(row => overlaps(row, start, end)))]));
        },
        async update(_source, row, changes) { attempt('update'); return { ...row, ...changes, version: '2' }; },
      };
    },
  };
  let service = new CalendarService(profile, providers);
  const run = (action, input) => service.run(action, input);
  const state = (options = {}) => run('state', { ...days, forceRefresh: false, ...options });
  const connect = async (name, ids, provider = 'ticktick') => {
    lists.set(name, ids.map(list));
    await run('connect', { name, provider });
    return profile.data.connections.find(entry => entry.name === name).id;
  };
  const restart = () => { profile.data = structuredClone(profile.data); service = new CalendarService(profile, providers); };
  const setInterval = (id, minutes) => run('setTickTickSyncInterval', { calendarId: id, minutes });
  const split = async (connectionId, names) => {
    const groups = names.map(name => ({ id: name, name, sourceIds: [JSON.stringify([connectionId, name])] }));
    await run('configureTickTick', { connectionId, mode: 'custom', groups });
    return Object.fromEntries((await state({ cachedOnly: true })).ticktickCalendars.map(row => [row.name, row.id]));
  };
  return { run, state, connect, restart, profile, calls, opened, failures, lists, rows, center, setInterval, split,
    get service() { return service; } };
}

test('52 lists use one date query, share persisted coverage across views and refresh the directory independently', async t => {
  const w = workspace(t);
  const ids = Array.from({ length: 55 }, (_, index) => 'list-' + index);
  const account = await w.connect('Work', ids);
  const included = ids.slice(0, 52);
  await w.run('configureTickTick', { connectionId: account, includedSourceIds: included.map(id => JSON.stringify([account, id])) });
  const first = await w.state();
  assert.deepEqual(w.calls, [{ name: 'Work', kind: 'directory' },
    { name: 'Work', kind: 'tasks', ids: included, start: '2026-11-16', end: '2026-11-28' }]);
  assert.equal(first.nextTickTickRefreshAt, now + 5 * minute);
  const original = first.health.map(row => row.checkedAt);
  w.calls.length = 0;
  t.mock.timers.tick(2 * minute);
  w.restart();
  assert.deepEqual((await w.state({ end: '2026-11-24' })).health.map(row => row.checkedAt), original);
  await w.state({ start: '2026-11-16', end: '2026-11-23' });
  assert.deepEqual(w.calls, []);
  t.mock.timers.tick(3 * minute);
  const refreshed = await w.state({ tickTickOnly: true });
  assert.deepEqual(w.calls.map(row => row.kind), ['tasks']);
  assert.deepEqual(w.calls[0].ids, included);
  assert.equal(refreshed.nextTickTickRefreshAt, now + 10 * minute);
  w.calls.length = 0;
  w.lists.get('Work').push(list('later'));
  t.mock.timers.tick(55 * minute);
  const rediscovered = await w.state();
  assert.deepEqual(w.calls.map(row => row.kind), ['directory', 'tasks']);
  assert.equal(rediscovered.sources.find(row => row.name === 'later').selected, false);
  await w.run('configureTickTick', { connectionId: account, includedSourceIds: null });
  w.calls.length = 0;
  await w.state({ preferencesOnly: true });
  assert.deepEqual(w.calls.map(row => row.ids), [[...ids.slice(52), 'later']]);
});

test('due lists share a read while slower, Manual, hidden and unrelated calendars keep their schedules', async t => {
  const w = workspace(t);
  const names = ['Work', 'Errands', 'Home', 'Manual'];
  const account = await w.connect('Personal', names);
  await w.connect('Native', ['Mac'], 'mac');
  const calendars = await w.split(account, names);
  await w.setInterval(calendars.Work, 1);
  await w.setInterval(calendars.Errands, 2);
  await w.setInterval(calendars.Manual, 0);
  await w.state({ forceRefresh: true });
  w.restart();
  w.calls.length = 0;
  t.mock.timers.tick(minute);
  assert.equal((await w.state({ tickTickOnly: true })).nextTickTickRefreshAt, now + 2 * minute);
  t.mock.timers.tick(minute);
  await w.state({ tickTickOnly: true });
  assert.deepEqual(w.calls.map(row => row.ids), [['Work'], ['Work', 'Errands']]);
  await w.run('setTickTickCalendarVisible', { connectionId: account, calendarId: calendars.Work, visible: false });
  await w.run('setTickTickCalendarVisible', { connectionId: account, calendarId: calendars.Errands, visible: false });
  t.mock.timers.tick(3 * minute);
  w.calls.length = 0;
  const scoped = await w.state({ tickTickOnly: true });
  assert.deepEqual(w.calls.map(row => row.ids), [['Home']]);
  assert.equal(scoped.nextTickTickRefreshAt, now + 10 * minute);
  await w.setInterval(calendars.Home, 0);
  t.mock.timers.tick(3_600_000);
  w.calls.length = 0;
  assert.equal((await w.state({ tickTickOnly: true })).nextTickTickRefreshAt, null);
  await w.state();
  assert.deepEqual(w.calls.filter(row => row.name === 'Personal'), []);
  const future = { start: '2027-02-02', end: '2027-02-03' };
  await w.state({ ...future, tickTickOnly: true });
  await w.state(future);
  await w.state(future);
  assert.deepEqual(w.calls.filter(row => row.name === 'Personal').map(row => row.ids), [['Home', 'Manual']]);
  w.calls.length = 0;
  await w.state({ ...future, forceRefresh: true });
  assert.deepEqual(w.calls.filter(row => row.name === 'Personal').map(row => row.kind), ['directory', 'tasks']);
  assert.deepEqual(w.calls.find(row => row.kind === 'tasks').ids, ['Home', 'Manual']);
  await assert.rejects(w.setInterval(calendars.Work, 3), /supported/);
  await assert.rejects(w.setInterval('unknown', 1), /available TickTick/);
});

test('reminders share warmed ranges, include hidden calendars and honor Manual between explicit checks', async t => {
  const w = workspace(t);
  const account = await w.connect('Tasks', ['Quick', 'Manual']);
  const calendars = await w.split(account, ['Quick', 'Manual']);
  await w.setInterval(calendars.Quick, 1);
  await w.setInterval(calendars.Manual, 0);
  w.rows.set('Tasks/Manual', [{ id: 'due', title: 'Due today', start: '2026-11-19T16:00Z', end: '2026-11-19T16:00Z', allDay: false }]);
  const bell = id => w.run('setCalendarNotifications', { calendarId: id, enabled: true, leadMinutes: 5 });
  await bell(calendars.Quick);
  await bell(calendars.Manual);
  assert.equal(w.service.nextTickTickNotificationCheckAt(), now + minute);
  assert.deepEqual(w.center.requests.map(row => row.title), ['Due today']);
  w.calls.length = 0;
  await w.state();
  await w.run('refreshNotifications');
  assert.deepEqual(w.calls, []);
  await w.run('setTickTickCalendarVisible', { connectionId: account, calendarId: calendars.Quick, visible: false });
  const replacements = w.center.replacements;
  t.mock.timers.tick(minute);
  await w.run('refreshNotifications', { tickTickOnly: true });
  assert.deepEqual(w.calls.map(row => row.ids), [['Quick']]);
  assert.equal(w.center.replacements, replacements);
  assert.equal(w.service.nextTickTickNotificationCheckAt(), now + 2 * minute);
  w.calls.length = 0;
  await w.run('setTickTickCalendarVisible', { connectionId: account, calendarId: calendars.Quick, visible: true });
  await w.state({ forceRefresh: true, refreshNotifications: true });
  assert.deepEqual(w.calls.map(row => row.kind), ['directory', 'tasks']);
  assert.deepEqual(w.calls[1].ids, ['Quick', 'Manual']);
  await w.setInterval(calendars.Quick, 0);
  w.calls.length = 0;
  t.mock.timers.tick(61 * minute);
  await w.run('refreshNotifications');
  assert.equal(w.service.nextTickTickNotificationCheckAt(), null);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.center.requests.map(row => row.title), ['Due today']);
});

test('an automatic tick opens credentials only for a due connection after restart', async t => {
  const w = workspace(t);
  for (const [name, minutes] of [['Fast', 1], ['Slow', 60], ['Manual', 0], ['Hidden', 1]]) {
    const id = await w.connect(name, ['list']);
    const calendar = (await w.state({ cachedOnly: true })).ticktickCalendars.find(row => row.connectionId === id);
    await w.setInterval(calendar.id, minutes);
    if (name === 'Hidden') await w.run('setTickTickCalendarVisible', { connectionId: id, calendarId: calendar.id, visible: false });
  }
  await w.state();
  w.restart();
  w.calls.length = w.opened.length = 0;
  t.mock.timers.tick(minute);
  await w.state({ tickTickOnly: true });
  assert.deepEqual(w.opened, ['Fast']);
  assert.deepEqual(w.calls.map(row => [row.name, row.kind]), [['Fast', 'tasks']]);
});

test('date chunks preserve successful coverage and stop at the first 429, including a zero-second delay', async t => {
  const w = workspace(t);
  await w.connect('Tasks', ['List']);
  const month = { start: '2026-11-01', end: '2026-12-01' };
  w.rows.set('Tasks/List', [allDay('long span', '2026-10-10', '2026-12-31'), allDay('last day', '2026-11-30', '2026-12-01')]);
  const requests = () => w.calls.filter(row => row.kind === 'tasks').map(row => [row.start, row.end]);
  let taskReads = 0;
  w.failures.set('Tasks', row => row.kind === 'tasks' && ++taskReads === 2 && Object.assign(new Error('Limited'), { status: 429, retryAt: now }));
  const failed = await w.state(month);
  assert.equal(failed.rangeCovered, false);
  assert.deepEqual(requests(), [['2026-11-01', '2026-11-13'], ['2026-11-13', '2026-11-25']]);
  assert.deepEqual(failed.items.map(row => row.id), ['long span']);
  assert.equal(failed.health.find(row => row.sourceId).checkedAt, null);
  w.failures.clear();
  w.calls.length = 0;
  assert.equal(failed.nextTickTickRefreshAt, now + minute);
  t.mock.timers.tick(minute - 1);
  await w.state(month);
  assert.deepEqual(requests(), []);
  t.mock.timers.tick(1);
  const retry = await w.state(month);
  assert.deepEqual(requests(), [['2026-11-13', '2026-11-25'], ['2026-11-25', '2026-12-01']]);
  assert.equal(retry.rangeCovered, true);
  assert.deepEqual(retry.items.map(row => row.id).sort(), ['last day', 'long span']);
  assert.equal(retry.nextTickTickRefreshAt, now + 5 * minute);
  w.rows.set('Tasks/List', [allDay('last day', '2026-11-30', '2026-12-01')]);
  await w.state({ start: '2026-11-02', end: '2026-11-03', forceRefresh: true });
  assert.deepEqual((await w.state({ ...month, cachedOnly: true })).items.map(row => row.id), ['last day']);
  w.calls.length = 0;
  const year = await w.state({ start: '2026-01-01', end: '2027-01-06', forceRefresh: true });
  assert.equal(requests().length, 31);
  assert.equal(year.rangeCovered, true);
  assert.equal(year.health[0].state, 'current');
  assert.equal(year.nextTickTickRefreshAt, now + 6 * minute);
});

test('an incomplete batch keeps cached data, retries at its deadline and hides unsupported diagnostic fields', async t => {
  const w = workspace(t);
  const id = await w.connect('Tasks', ['One', 'Two']);
  w.rows.set('Tasks/One', [allDay('One task', days.start, days.end)]);
  w.rows.set('Tasks/Two', [allDay('Two task', days.start, days.end)]);
  const loaded = await w.state();
  const client = w.service.clients.get(id).client;
  const original = client.itemsForSources;
  client.itemsForSources = async () => new Map([['One', []]]);
  const failed = await w.state({ forceRefresh: true });
  assert.deepEqual(failed.items, loaded.items);
  assert(failed.health.every(row => row.state === 'stale' && row.checkedAt === loaded.health[0].checkedAt));
  client.itemsForSources = original;
  w.calls.length = 0;
  await w.state();
  assert.deepEqual(w.calls, []);
  t.mock.timers.tick(5 * minute);
  const current = await w.state({ tickTickOnly: true });
  assert(current.health.every(row => row.state === 'current' && row.checkedAt === new Date(now + 5 * minute).toISOString()));
  assert.equal(current.nextTickTickRefreshAt, now + 10 * minute);
  const connection = w.profile.data.connections[0];
  connection.tickTickRequestStats = { lists: { count: 2, lastAt: now, lastStatus: 200, path: 'private' },
    '/private/task/abc': { count: 9, lastAt: now } };
  assert.deepEqual((await w.state({ cachedOnly: true })).connections[0].tickTickRequestStats,
    { lists: { count: 2, lastAt: now, lastStatus: 200 } });
});

test('a bulk refresh queued during a write preserves the confirmed item and refreshes other lists', async t => {
  const w = workspace(t);
  const id = await w.connect('Tasks', ['One', 'Two']);
  w.rows.set('Tasks/One', [allDay('target', days.start, days.end)]);
  w.rows.set('Tasks/Two', [allDay('old', days.start, days.end)]);
  const [original] = (await w.state()).items;
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  w.service.clients.get(id).client.update = async (_source, item, draft) => {
    started.resolve();
    await finish.promise;
    return { ...item, ...draft, version: 'confirmed' };
  };
  const saving = w.run('save', { ...original, title: 'Updated' });
  await started.promise;
  w.rows.set('Tasks/Two', [allDay('new', days.start, days.end)]);
  const reading = w.state({ forceRefresh: true });
  finish.resolve();
  await saving;
  assert.deepEqual((await reading).items.map(row => [row.id, row.version]), [['target', 'confirmed'], ['new', '1']]);
});

test('a muted Manual list drops a moved task when its new list is read, without touching another account', async t => {
  const w = workspace(t);
  const personal = await w.connect('Tasks', ['Manual', 'Fast']);
  await w.connect('Other', ['Manual']);
  const calendars = await w.split(personal, ['Manual', 'Fast']);
  await w.setInterval(calendars.Manual, 0);
  await w.setInterval(calendars.Fast, 1);
  const task = allDay('same', days.start, days.end);
  w.rows.set('Tasks/Manual', [task]);
  w.rows.set('Other/Manual', [{ ...task, title: 'Other account' }]);
  const loaded = await w.state();
  const former = loaded.items.find(row => row.title === 'same');
  w.rows.set('Tasks/Fast', [{ ...task, title: 'Moved' }]);
  w.rows.delete('Tasks/Manual');
  t.mock.timers.tick(minute);
  const moved = await w.state({ tickTickOnly: true });
  assert.deepEqual(moved.items.map(row => row.title), ['Moved', 'Other account']);
  await assert.rejects(w.run('save', former), { code: 'CONFLICT' });
  w.restart();
  assert.deepEqual((await w.state({ cachedOnly: true })).items, moved.items);
  assert.deepEqual(w.center.requests, []);
});

test('the check time is shared by all lists in a bulk response even when caching its items takes time', async t => {
  const w = workspace(t);
  const account = await w.connect('Tasks', ['One', 'Two', 'Three']);
  const calendar = (await w.state({ cachedOnly: true })).ticktickCalendars.find(row => row.connectionId === account);
  await w.setInterval(calendar.id, 1);
  const store = w.service.storeFetchedItems.bind(w.service);
  w.service.storeFetchedItems = (...args) => {
    t.mock.timers.tick(25);
    return store(...args);
  };
  const loaded = await w.state();
  assert.deepEqual([...new Set(loaded.health.map(row => row.checkedAt))], [new Date(now).toISOString()]);
  assert.equal(loaded.nextTickTickRefreshAt, now + minute);
  t.mock.timers.tick(minute - 75);
  w.calls.length = 0;
  await w.state({ tickTickOnly: true });
  assert.deepEqual(w.calls.map(row => row.ids), [['One', 'Two', 'Three']]);
});

test('intervals follow stable calendars through renames, restarts, group removal and disconnect', async t => {
  const w = workspace(t);
  const account = await w.connect('Tasks', ['One', 'Two']);
  const original = (await w.state({ cachedOnly: true })).ticktickCalendars[0];
  await w.setInterval(original.id, 30);
  const custom = await w.split(account, ['One', 'Two']);
  await w.setInterval(custom.One, 1);
  await w.setInterval(custom.Two, 0);
  const groups = ['One', 'Two'].map(name => ({ id: name, name: name + ' renamed', sourceIds: [JSON.stringify([account, name])] }));
  await w.run('configureTickTick', { connectionId: account, groups });
  w.restart();
  const renamed = (await w.state({ cachedOnly: true })).ticktickCalendars;
  assert.deepEqual(renamed.map(row => [row.name, row.syncMinutes]), [['One renamed', 1], ['Two renamed', 0]]);
  await w.run('configureTickTick', { connectionId: account, groups: groups.slice(1) });
  assert(!Object.hasOwn(w.profile.data.tickTickSyncIntervals, custom.One));
  await w.run('configureTickTick', { connectionId: account, mode: 'account' });
  assert.equal((await w.state({ cachedOnly: true })).ticktickCalendars[0].syncMinutes, 30);
  const save = w.profile.save;
  w.profile.save = () => { throw new Error('Disk full'); };
  await assert.rejects(w.setInterval(original.id, 15), /Disk full/);
  w.profile.save = save;
  assert.equal((await w.state({ cachedOnly: true })).ticktickCalendars[0].syncMinutes, 30);
  await w.run('disconnect', { connectionId: account });
  assert.deepEqual(w.profile.data.tickTickSyncIntervals, {});
});

test('a 429 blocks foreground, reminders, writes and reconnect for its account across restart without advancing freshness', async t => {
  const w = workspace(t);
  const a = await w.connect('First', ['a', 'b']);
  await w.connect('Second', ['a']);
  w.rows.set('First/a', [allDay('saved', days.start, days.end)]);
  const first = await w.state();
  const item = first.items[0];
  const id = first.ticktickCalendars.find(row => row.connectionId === a).id;
  await w.run('setCalendarNotifications', { calendarId: id, enabled: true, leadMinutes: 0 });
  const retryAt = now + 2 * minute;
  w.failures.set('First', call => call.kind === 'directory' && Object.assign(new Error('Busy'), { status: 429, retryAt }));
  w.calls.length = 0;
  const failed = await w.state({ forceRefresh: true, refreshNotifications: true });
  assert.deepEqual(w.calls.filter(row => row.name === 'First').map(row => row.kind), ['directory']);
  assert.deepEqual(w.calls.filter(row => row.name === 'Second').map(row => row.kind), ['directory', 'tasks']);
  const last = failed.health.find(row => row.sourceId === item.sourceId);
  assert.deepEqual([last.state, last.checkedAt, last.retryAt], ['stale', new Date(now).toISOString(), retryAt]);
  w.restart();
  w.calls.length = 0;
  assert.equal((await w.state({ cachedOnly: true })).health.find(row => row.connectionId === a).retryAt, retryAt);
  await w.state();
  await w.state({ forceRefresh: true, refreshNotifications: true });
  await w.run('refreshNotifications');
  await assert.rejects(w.run('connect', { provider: 'ticktick', name: 'First', connectionId: a }), { code: 'RATE_LIMITED' });
  await assert.rejects(w.run('save', item), { code: 'RATE_LIMITED' });
  assert.deepEqual(w.profile.data.journal, []);
  assert.deepEqual(w.calls.filter(row => row.name === 'First'), []);
  w.failures.delete('First');
  t.mock.timers.tick(2 * minute);
  w.calls.length = 0;
  const recovered = await w.state({ forceRefresh: true, refreshNotifications: true });
  assert.deepEqual(w.calls.filter(row => row.name === 'First').map(row => row.kind), ['directory', 'tasks']);
  assert(recovered.health.every(row => row.state === 'current'));
});
