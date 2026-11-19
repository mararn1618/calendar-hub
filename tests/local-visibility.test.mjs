import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { CalendarService } from '../desktop/calendar-service.mjs';

function exchangeProfile() {
  const range = { start: '2026-11-19', end: '2026-11-22' };
  const calendar = { id: 'work', name: 'Work', writable: false };
  const connection = { id: 'account', provider: 'exchange', route: 'mac' };
  const sourceId = JSON.stringify([connection.id, calendar.id]);
  const item = { id: 'meeting', title: 'Office days', allDay: true, ...range };
  const source = { id: sourceId, remoteId: calendar.id, connectionId: connection.id, provider: 'exchange',
    remote: calendar, name: calendar.name, selected: true, writable: false, readOnly: true };
  const profile = { data: { connections: [connection], sources: [source], cache: { [sourceId]: { items: [item], checks: [] } },
    hidden: [], journal: [] }, open: () => ({}), save() {} };
  return { range, calendar, sourceId, item, profile };
}

test('an Exchange header entry can be hidden and restored from the cache while a refresh waits for the provider', async () => {
  const { range, calendar, profile } = exchangeProfile();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let reads = 0;
  const registry = { client: () => ({
    sources: async () => [calendar],
    async items() {
      reads++;
      started.resolve();
      await release.promise;
      throw new Error('Mac calendar access denied');
    }
  }) };
  const service = new CalendarService(profile, registry);
  const saved = () => service.run('state', { ...range, cachedOnly: true });
  const refresh = service.run('state', range);
  try {
    await started.promise;
    const selected = (await saved()).items[0];
    await Promise.race([service.run('hide', selected), setImmediate()]);
    assert.deepEqual((await saved()).items, [], 'The cached entry is still visible while the provider refresh waits.');
    await Promise.race([service.run('restore', selected), setImmediate()]);
    assert.deepEqual((await saved()).items, [selected]);
    assert.equal(reads, 1);
  } finally {
    release.resolve();
    await refresh;
  }
});

test('a hidden Exchange occurrence follows its server identity through a local ID change and restart', async () => {
  const { range, calendar, profile, item, sourceId } = exchangeProfile();
  const first = { ...item, recurring: true, visibilityId: 'uid:c2VyaWVz|2026-11-19' };
  const second = { ...first, id: 'other-occurrence', visibilityId: 'uid:c2VyaWVz|2026-11-21' };
  let rows = [first, second];
  const registry = { client: () => ({ sources: async () => [calendar], items: async () => structuredClone(rows) }) };
  const service = new CalendarService(profile, registry);
  // Profiles from previous releases only have the local EventKit ID.
  profile.data.hidden.push({ sourceId, id: first.id, title: first.title });
  assert.deepEqual((await service.run('state', range)).items.map(row => row.id), [second.id]);
  rows = [{ ...first, id: 'new-local-id', title: 'Renamed meeting' }, second];
  const restarted = new CalendarService({ ...profile, data: structuredClone(profile.data) }, registry);
  const refreshed = await restarted.run('state', range);
  assert.deepEqual(refreshed.items.map(row => row.id), [second.id], 'The hidden occurrence returned with its new local ID.');
  await restarted.run('restore', refreshed.hidden[0]);
  assert.deepEqual((await restarted.run('state', { ...range, cachedOnly: true })).items.map(row => row.id), ['new-local-id', second.id]);
});
