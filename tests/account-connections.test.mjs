import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarService } from '../desktop/calendar-service.mjs';
import { createDesktopRegistry } from '../desktop/providers/integrations.mjs';
import { createIntegrationRegistry } from '../desktop/providers/registry.mjs';
import { startProviderServer } from './provider-server.mjs';

const period = { start: '2026-11-19', end: '2026-11-20' };
const key = (account, id) => JSON.stringify([account, id]);
const nativeRows = [
  { id: 'home-cal', name: 'Calendar', accountId: 'home', accountName: 'Google', writable: true },
  { id: 'work-cal', name: 'Calendar', accountId: 'work', accountName: 'Google', writable: true },
];

function memoryProfile() {
  return {
    data: { connections: [], sources: [], cache: {}, hidden: [], journal: [] },
    seal: value => structuredClone(value), open: row => structuredClone(row.secret), save() {},
  };
}

test('a rate-limited first TickTick connection keeps its deadline across retries and restarts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const provider = await startProviderServer({ multipleAccounts: true });
  t.after(() => provider.close());
  const registry = createDesktopRegistry({ testOrigin: provider.origin });
  const profile = memoryProfile();
  const [one, two] = provider.accounts;
  one.tickToken = 'first-isolated-token';
  two.tickToken = 'second-isolated-token';
  const connect = (service, token) => service.run('connect', { provider: 'ticktick', route: 'token', token });
  const clear = provider.controls.blockTickReads(30 * 60);
  const limited = { code: 'RATE_LIMITED' };
  const service = new CalendarService(profile, registry);
  await assert.rejects(connect(service, one.tickToken), limited);
  const reopened = memoryProfile();
  reopened.data = JSON.parse(JSON.stringify(profile.data));
  assert(!JSON.stringify(reopened.data).includes(one.tickToken));
  const restored = new CalendarService(reopened, registry);
  await assert.rejects(connect(restored, one.tickToken), limited);
  assert.equal(provider.controls.requests.length, 1);
  await connect(restored, two.tickToken);
  assert.equal(reopened.data.connections.length, 1);
  t.mock.timers.tick(30 * 60_000);
  await clear();
  await connect(restored, one.tickToken);
  assert.equal(reopened.data.connections.length, 2);
  assert(!Object.keys(reopened.data.pendingTickTickLimits || {}).length);
});

function oldMacProfile(rows) {
  const profile = memoryProfile();
  const id = 'original-account';
  profile.data.connections.push({ id, name: 'Google via Apple Calendar', provider: 'google', route: 'mac',
    accountKey: 'google-via-apple-calendar', secret: { route: 'mac', googleCalendarIds: nativeRows.map(row => row.id) } });
  for (const row of nativeRows) {
    profile.data.sources.push({ id: key(id, row.id), remoteId: row.id, connectionId: id, provider: 'google', name: row.name,
      remote: { id: row.id, accountName: row.accountName, name: row.name, writable: true },
      selected: true, writable: true, readOnly: row.accountId === 'work' });
  }
  const item = { id: 'old-event', title: 'Meeting', ...period, allDay: true, version: '1' };
  const oldKey = key(id, 'work-cal');
  profile.data.cache[oldKey] = { items: [item], checks: [] };
  profile.data.hidden.push({ id: item.id, title: item.title, sourceId: oldKey });
  profile.data.journal.push({ id: 'pending-write', sourceId: oldKey, connectionId: id, kind: 'update' });
  profile.data.notificationPreferences = { [oldKey]: { enabled: false, leadMinutes: 22 } };
  profile.data.calendarColorOverrides = { [oldKey]: '#7244aa' };
  const registry = createDesktopRegistry({ testOrigin: 'http://127.0.0.1:1', macCalendar: ({ accountId, googleCalendarIds }) => ({
    authorize: async () => rows,
    sources: async () => rows.filter(row => (!accountId || accountId === row.accountId) && googleCalendarIds.includes(row.id)),
    items: async row => row.accountId === 'work' ? [item] : [],
  }) });
  return { profile, registry, service: new CalendarService(profile, registry), oldKey, id };
}

test('an aggregate Google connection splits by native account ID without losing preferences, hidden events, cached items or pending writes', async () => {
  const rows = nativeRows.slice();
  const { service, profile, registry, oldKey, id } = oldMacProfile(rows);
  let view = await service.run('state', period);
  assert.deepEqual(view.connections.map(row => row.name), ['Google', 'Google (2)']);
  const [home, work] = view.connections;
  assert.equal(home.id, id);
  assert.deepEqual([home.accountId, work.accountId], ['home', 'work']);
  const moved = key(work.id, 'work-cal');
  assert.equal(view.sources.find(source => source.id === moved).readOnly, true);
  assert.equal(view.sources.find(source => source.id === moved).selected, true);
  assert.equal(profile.data.cache[moved].items[0].id, 'old-event');
  assert.equal(profile.data.cache[oldKey], undefined);
  assert.equal(view.hidden[0].sourceId, moved);
  assert.equal(view.uncertain[0].sourceId, moved);
  assert.equal(view.uncertain[0].connectionId, work.id);
  assert.equal(view.notificationPreferences[moved].leadMinutes, 22);
  assert.equal(view.notificationPreferences[oldKey], undefined);
  assert.equal(view.sources.find(source => source.id === moved).color, '#7244aa');
  assert.equal(profile.data.calendarColorOverrides[oldKey], undefined);
  assert(!view.connections.some(row => row.legacyMac || row.secret));
  assert.deepEqual(profile.data.connections.map(row => row.secret.googleCalendarIds), [['home-cal'], ['work-cal']]);
  const restored = new CalendarService(profile, registry);
  await restored.run('disconnect', { connectionId: home.id });
  await assert.rejects(restored.run('disconnect', { connectionId: work.id }), /unconfirmed/);
  view = await restored.run('state', period);
  assert.deepEqual(view.connections, [work]);
  assert.equal(view.hidden[0].sourceId, moved);
});

test('unavailable calendars retain their old account and settings until Apple Calendar can identify every owner', async () => {
  const rows = nativeRows.slice(0, 1);
  const { service, profile, oldKey, id } = oldMacProfile(rows);
  let view = await service.run('state', period);
  assert.deepEqual(view.connections.map(account => [account.id, account.legacyMac]), [[id, true]]);
  assert.equal(view.uncertain[0].sourceId, oldKey);
  assert.equal(profile.data.unavailableSourceSettings[oldKey].readOnly, true);
  const picker = await service.run('macAccountCalendars', { provider: 'google', connectionId: id });
  assert.deepEqual(picker.map(row => [row.id, row.chosen, Boolean(row.unavailable)]), [['home-cal', true, false], ['work-cal', true, true]]);
  rows.push({ ...nativeRows[0], id: 'second-home-cal' });
  await service.run('connect', { provider: 'google', route: 'mac', connectionId: id, googleCalendarIds: ['home-cal', 'second-home-cal'] });
  assert.deepEqual(new Set(profile.data.connections[0].secret.googleCalendarIds), new Set(['home-cal', 'second-home-cal', 'work-cal']));
  rows.push(nativeRows[1]);
  view = await service.run('state', period);
  assert.equal(view.connections.length, 2);
  const work = view.sources.find(source => source.id === key(view.connections[1].id, 'work-cal'));
  assert.equal(work.readOnly, true);
  assert.equal(work.selected, true);
  assert.equal(view.uncertain[0].sourceId, work.id);
});

test('an older aggregate merges a returning calendar into an account connected during an outage', async () => {
  const rows = [nativeRows[0], { ...nativeRows[1], id: 'team-cal' }];
  const { profile, service, oldKey } = oldMacProfile(rows);
  await service.run('state', period);
  await service.run('connect', { provider: 'google', route: 'mac', accountId: 'work', googleCalendarIds: ['team-cal'], name: 'Studio' });
  let view = await service.run('state', period);
  const studio = view.connections.find(row => row.name === 'Studio');
  const otherCalendar = key(studio.id, 'team-cal');
  await service.run('setSource', { sourceId: otherCalendar, selected: false });
  rows.push(nativeRows[1]);
  view = await service.run('state', period);
  assert.equal(view.connections.length, 2);
  assert(view.connections.every(row => row.accountId && !row.legacyMac));
  assert.equal(view.connections.find(row => row.accountId === 'work').id, studio.id);
  assert.deepEqual(new Set(profile.data.connections.find(row => row.id === studio.id).secret.googleCalendarIds), new Set(['team-cal', 'work-cal']));
  assert.equal(view.sources.find(row => row.id === otherCalendar).selected, false);
  assert.equal(view.sources.find(row => row.id === key(studio.id, 'work-cal')).readOnly, true);
  assert.equal(view.uncertain[0].connectionId, studio.id);
  assert.equal(view.hidden[0].sourceId, key(studio.id, 'work-cal'));
  assert.equal(profile.data.cache[oldKey], undefined);
  assert.equal(view.notificationPreferences[key(studio.id, 'work-cal')].leadMinutes, 22);
});

test('an unselected native calendar keeps its earlier settings under the correct account', async () => {
  const archived = { ...nativeRows[1], id: 'formerly-selected' };
  const { profile, service, id } = oldMacProfile([...nativeRows, archived]);
  const oldKey = key(id, archived.id);
  profile.data.unavailableSourceSettings[oldKey] = { selected: false, readOnly: true };
  profile.data.hidden.push({ id: 'old', title: 'Earlier event', sourceId: oldKey });
  let view = await service.run('state', period);
  const work = view.connections.find(account => account.accountId === 'work');
  const actual = key(work.id, archived.id);
  assert.equal(view.hidden.find(entry => entry.id === 'old').sourceId, actual);
  assert(!view.sources.some(row => row.id === actual));
  await service.run('connect', { provider: 'google', route: 'mac', connectionId: work.id, accountId: 'work',
    googleCalendarIds: [archived.id, 'work-cal'] });
  view = await service.run('state', period);
  const source = view.sources.find(row => row.id === actual);
  assert.equal(source.readOnly, true);
  assert.equal(source.selected, false);
});

test('two instances of a registered integration keep credentials, writes and local state separate even with identical remote IDs', async () => {
  const profile = memoryProfile();
  const calls = [];
  const registry = createIntegrationRegistry([{
    id: 'example', name: 'Example calendar', itemKind: 'event', routes: ['browser'],
    authorize: async ({ login }) => ({ login, grant: 'private-' + login }),
    identity: secret => secret.login,
    client: secret => ({
      sources: async () => [{ id: 'calendar', name: 'Appointments', writable: true }],
      items: async () => [{ id: 'meeting', title: secret.login, ...period, allDay: true, version: 'v1', canEdit: true }],
      update: async (source, original, draft) => {
        calls.push([secret.login, source.id, original.id, draft.title]);
        return { ...original, ...draft, version: 'v2' };
      },
    }),
  }]);
  const service = new CalendarService(profile, registry);
  await service.run('connect', { provider: 'example', login: 'one' });
  await service.run('connect', { provider: 'example', login: 'two' });
  const initial = await service.run('state', period);
  const [one, two] = initial.connections;
  assert.deepEqual(initial.connections.map(row => row.name), ['Example calendar', 'Example calendar (2)']);
  assert(initial.sources.every(row => row.itemKind === 'event'));
  await service.run('renameConnection', { connectionId: two.id, name: 'Work' });
  await assert.rejects(service.run('renameConnection', { connectionId: one.id, name: 'Work' }), /already uses/);
  for (const source of initial.sources) await service.run('setSource', { sourceId: source.id, selected: true });
  const view = await service.run('state', period);
  assert.equal(view.items.length, 2);
  const item = view.items.find(row => row.sourceId === key(two.id, 'calendar'));
  await service.run('save', { ...item, title: 'Updated' });
  assert.deepEqual(calls, [['two', 'calendar', 'meeting', 'Updated']]);
  await service.run('hide', view.items.find(row => row.sourceId === key(one.id, 'calendar')));
  await assert.rejects(service.run('connect', { provider: 'example', connectionId: one.id, login: 'two' }), /already connected/);
  await assert.rejects(service.run('connect', { provider: 'example', connectionId: one.id, login: 'three' }), /same account/);
  await service.run('connect', { provider: 'example', connectionId: two.id, login: 'two' });
  const restarted = new CalendarService(profile, registry);
  await restarted.run('disconnect', { connectionId: one.id });
  const after = await restarted.run('state', period);
  assert.deepEqual(after.connections.map(row => [row.id, row.name]), [[two.id, 'Work']]);
  assert.deepEqual(after.items.map(row => row.title), ['two']);
  assert.deepEqual(after.hidden, []);
  assert.doesNotMatch(JSON.stringify(after), /private-/);
});

test('a read-only integration cannot write even when an upstream calendar reports write access', async () => {
  const profile = memoryProfile();
  let writes = 0;
  const registry = createIntegrationRegistry([{
    id: 'mirror', name: 'Mirror', itemKind: 'event', routes: ['browser'], readOnly: true,
    authorize: async () => ({}), identity: () => 'account', client: () => ({
      sources: async () => [{ id: 'shared', name: 'Shared', writable: true }],
      items: async () => [], create: async () => { writes++; },
    }),
  }]);
  const service = new CalendarService(profile, registry);
  await service.run('connect', { provider: 'mirror' });
  const [source] = (await service.run('state', period)).sources;
  await service.run('setSource', { sourceId: source.id, selected: true, readOnly: false });
  await assert.rejects(service.run('save', { sourceId: source.id, title: 'Meeting', allDay: true, ...period }), /read-only/);
  assert.equal(writes, 0);
});
