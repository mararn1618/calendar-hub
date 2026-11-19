import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMacCalendar } from '../desktop/providers/mac.mjs';
import { startMacCalendarFixture } from './fixtures/mac-calendar.mjs';

const execute = promisify(execFile);
const calendars = [
  { id: 'personal', name: 'Personal', accountName: 'My Google account', writable: true },
  { id: 'other', name: 'Work', accountName: 'Other CalDAV account', writable: true },
  { id: 'subscribed', name: 'Holidays', accountName: 'My Google account', writable: false },
];
const appointment = {
  providerCalendarId: 'personal', id: 'uid:ZXZlbnQ=', title: 'Appointment', version: 'cached-version',
  allDay: false, start: '2026-11-20T11:00:00.000Z', end: '2026-11-20T12:00:00.000Z', canEdit: true,
};

function fixture() {
  const calls = [];
  const executeHelper = async (_executable, args, input) => {
    calls.push({ args, input });
    if (args[0] === 'items') return JSON.stringify([appointment]);
    if (['sources', 'accounts', 'authorize'].includes(args[0])) return JSON.stringify(calendars);
    if (args[0] === 'remove') return JSON.stringify({ removed: true });
    return JSON.stringify({ ...appointment, ...input.draft, version: 'saved-version' });
  };
  return { calls, executeHelper };
}

test('Mac permission requests require an explicit setup call and discovery keeps unchosen Google calendars out', async () => {
  const bridge = fixture();
  const mac = createMacCalendar(bridge);
  assert.deepEqual(bridge.calls, []);
  assert.deepEqual(await mac.authorize({ google: true }), calendars);
  const readOnly = await mac.sources();
  assert.ok(readOnly.every(calendar => !calendar.writable));
  await mac.items(readOnly[0], '2026-11-20', '2026-11-21');
  await assert.rejects(mac.create(calendars[0], appointment), { code: 'READ_ONLY' });
  const google = createMacCalendar({ ...bridge, googleCalendarIds: ['personal', 'subscribed'] });
  assert.deepEqual(await google.sources(), [calendars[0], calendars[2]]);
  await assert.rejects(google.create(calendars[1], appointment), { code: 'UNSELECTED' });
  await assert.rejects(google.create(calendars[2], appointment), { code: 'READ_ONLY' });
  assert.throws(() => google.items(calendars[1], '2026-11-20', '2026-11-21'), { code: 'UNSELECTED' });
  assert.deepEqual(bridge.calls.map(call => call.args), [
    ['authorize', 'google'], ['sources', 'mac'], ['items', 'mac', 'personal', '2026-11-20', '2026-11-21'],
    ['sources', 'google', JSON.stringify({ googleCalendarIds: ['personal', 'subscribed'] })],
  ]);
});

test('native account inventory uses existing permission without asking for access after a denial', async () => {
  const calls = [];
  const executeHelper = async (_executable, args) => {
    calls.push(args);
    return JSON.stringify({ code: 'PERMISSION', error: 'Calendar access is unavailable.' });
  };
  const inspect = (options, input) => createMacCalendar({ ...options, executeHelper }).authorize({ ...input, requestAccess: false });
  await assert.rejects(inspect({ provider: 'google' }), { code: 'PERMISSION' });
  await assert.rejects(inspect({}, { google: true }), { code: 'PERMISSION' });
  await assert.rejects(inspect({ provider: 'exchange' }), { code: 'PERMISSION' });
  assert.deepEqual(calls, [['accounts', 'google'], ['accounts', 'google'], ['accounts', 'exchange']]);
});

test('native Google edits send the selected calendar, version, original occurrence time and guest review', async () => {
  const bridge = fixture();
  const google = createMacCalendar({ ...bridge, googleCalendarIds: ['personal'] });
  const [original] = await google.items(calendars[0], '2026-11-20', '2026-11-21');
  const draft = { ...original, title: 'New title', notify: true, occurrence: true, ignored: 'omit' };
  assert.equal((await google.create(calendars[0], draft)).title, 'New title');
  assert.equal((await google.update(calendars[0], original, draft)).version, 'saved-version');
  assert.deepEqual(bridge.calls.at(-1), {
    args: ['update', 'google', 'personal', JSON.stringify({ googleCalendarIds: ['personal'] })],
    input: {
      notify: true, occurrence: true,
      original: { id: original.id, version: original.version, allDay: false, start: original.start },
      draft: { title: 'New title', start: original.start, end: original.end, allDay: false },
    },
  });
  await google.remove(calendars[0], original, { notify: true, occurrence: true });
  assert.deepEqual(bridge.calls.at(-1).args, ['remove', 'google', 'personal', JSON.stringify({ googleCalendarIds: ['personal'] })]);
  await assert.rejects(google.update(calendars[0], { ...original, providerCalendarId: 'other' }, draft), { code: 'CONFLICT' });
});

test('scopes Google and Exchange by native account ID and rechecks calendar ownership before reads and writes', async t => {
  const calendars = [
    { id: 'google-a', accountId: 'a', calDAV: true }, { id: 'other-a', accountId: 'a', calDAV: true },
    { id: 'google-b', accountId: 'b', calDAV: true }, { id: 'exchange-c', accountId: 'c', exchange: true },
    { id: 'exchange-d', accountId: 'd', exchange: true }, { id: 'local', accountId: 'e' },
  ].map(row => ({ ...row, name: 'Calendar', accountName: 'Work', writable: true }));
  const fixture = await startMacCalendarFixture(calendars);
  t.after(fixture.close);
  const executeHelper = async (_executable, args, input) => {
    const response = await fetch(fixture.origin + '/mac-helper', { method: 'POST', body: JSON.stringify({ args, input }) });
    return response.text();
  };
  const client = options => createMacCalendar({ ...options, executeHelper });
  const google = client({ provider: 'google', accountId: 'a', googleCalendarIds: ['google-a', 'google-b'] });
  const exchange = client({ provider: 'exchange', accountId: 'c' });
  const ids = rows => rows.map(row => row.id);
  const inventory = await client({ provider: 'google' }).authorize({ requestAccess: false });
  assert.deepEqual(ids(inventory), ['google-a', 'other-a', 'google-b']);
  assert.deepEqual(Object.keys(inventory[0]).sort(), ['accountId', 'accountName', 'id', 'name', 'writable']);
  assert.deepEqual(ids(await google.authorize({ requestAccess: false })), ['google-a', 'other-a']);
  assert.deepEqual(ids(await client({ provider: 'exchange' }).authorize({ requestAccess: false })), ['exchange-c', 'exchange-d']);
  assert.ok(fixture.calls.every(call => call.action === 'accounts'));
  assert.deepEqual(ids(await client({ provider: 'google' }).authorize()), ['google-a', 'other-a', 'google-b']);
  assert.deepEqual(ids(await google.authorize()), ['google-a', 'other-a']);
  const exchangeCandidates = await client({ provider: 'exchange' }).authorize();
  assert.deepEqual(exchangeCandidates.map(row => [row.accountId, row.writable]), [['c', false], ['d', false]]);
  assert.deepEqual(await client({ provider: 'exchange' }).sources(), []);
  assert.deepEqual(await client({ provider: 'google', accountId: 'a' }).sources(), []);
  const sources = await google.sources();
  assert.deepEqual(ids(sources), ['google-a']);
  const [source] = sources;
  const meetingSources = await exchange.sources();
  assert.deepEqual(ids(meetingSources), ['exchange-c']);
  const [meeting] = meetingSources;
  assert.throws(() => google.items(calendars[2], '2026-11-20', '2026-11-21'), { code: 'UNSELECTED' });
  assert.throws(() => google.items(calendars[1], '2026-11-20', '2026-11-21'), { code: 'UNSELECTED' });
  assert.throws(() => exchange.items(calendars[4], '2026-11-20', '2026-11-21'), { code: 'UNSELECTED' });
  fixture.events.set('meeting', { ...appointment, id: 'meeting', providerCalendarId: meeting.id });
  const [exchangeEvent] = await exchange.items(meeting, '2026-11-20', '2026-11-21');
  assert.equal(exchangeEvent.canEdit, false);
  assert.equal(exchangeEvent.canDelete, false);
  const forged = { ...meeting, writable: true };
  for (const action of ['create', 'update', 'remove']) {
    await assert.rejects(exchange[action](forged, exchangeEvent, appointment), { code: 'READ_ONLY' });
  }
  assert.ok(!fixture.calls.some(call => ['create', 'update', 'remove'].includes(call.action)));
  const saved = await google.create(source, appointment);
  calendars[0].accountId = 'b';
  calendars[3].accountId = 'd';
  assert.deepEqual(await google.sources(), []);
  assert.deepEqual(await exchange.sources(), []);
  await assert.rejects(exchange.items(meeting, '2026-11-20', '2026-11-21'), { code: 'UNAVAILABLE' });
  await assert.rejects(google.items(source, '2026-11-20', '2026-11-21'), { code: 'UNAVAILABLE' });
  await assert.rejects(google.create(source, appointment), { code: 'UNAVAILABLE' });
  await assert.rejects(google.update(source, saved, appointment), { code: 'UNAVAILABLE' });
  await assert.rejects(google.remove(source, saved), { code: 'UNAVAILABLE' });
  assert.equal(fixture.events.get(saved.id).version, saved.version);
});

test('keeps uncertain native writes separate from known permission and conflict errors', async () => {
  for (const [response, code] of [
    ['{}', 'UNCERTAIN'], ['broken response', 'UNCERTAIN'], [JSON.stringify({ ...appointment, providerCalendarId: 'other' }), 'UNCERTAIN'],
    ['{"error":"Changed","code":"CONFLICT"}', 'CONFLICT'], ['{"error":"Denied","code":"PERMISSION"}', 'PERMISSION'],
  ]) {
    const google = createMacCalendar({ googleCalendarIds: ['personal'], executeHelper: async () => response });
    await assert.rejects(google.update(calendars[0], appointment, appointment), { code });
  }
  const google = createMacCalendar({ googleCalendarIds: ['personal'], executeHelper: async () => { throw new Error('Disconnected'); } });
  await assert.rejects(google.create(calendars[0], appointment), { code: 'UNCERTAIN' });
  const missing = createMacCalendar({ executable: '/nonexistent-calendar-helper', googleCalendarIds: ['personal'] });
  await assert.rejects(missing.create(calendars[0], appointment), { code: 'NATIVE' });
});

test('EventKit handles DST, appointment edits, invitations and occurrence scope without saving any events', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-native-tests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'native-tests');
  const target = (process.arch === 'arm64' ? 'arm64' : 'x86_64') + '-apple-macos14.0';
  const files = ['../native/MacCalendars.swift', './mac-native.swift'].map(file => fileURLToPath(new URL(file, import.meta.url)));
  await execute('xcrun', ['swiftc', '-parse-as-library', '-D', 'MAC_CALENDAR_TESTS', '-target', target, ...files, '-o', output]);
  await execute(output, [], { env: { ...process.env, TZ: 'Europe/Berlin' } });
});
