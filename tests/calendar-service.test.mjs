import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalendarService } from '../desktop/calendar-service.mjs';

function workspace() {
  const dates = { start: '2026-11-19', end: '2026-11-20' };
  const items = [{ id: 'meeting', title: 'Work meeting', ...dates, allDay: true, version: 'one',
    canEdit: true, canDelete: true, hasAttendees: false, completed: false }];
  const profile = { data: { connections: [], sources: [], cache: {}, hidden: [], journal: [] }, seal: value => value, open: c => c.secret, save() {} };
  const remote = { sources: async () => [{ id: 'copy', name: 'Work', writable: true }], items: async () => structuredClone(items) };
  const registry = { authorize: async () => ({}), client: () => remote, identity: () => 'calendar-account' };
  return { dates, profile, remote, registry, service: new CalendarService(profile, registry) };
}

test('local read-only policy blocks source writes and still supports hiding across restart', async () => {
  const { dates, profile, service, registry, remote } = workspace();
  remote.remove = () => assert.fail('read-only deletion reached the provider');
  await service.run('connect', { provider: 'google' });
  let view = await service.run('state', dates);
  assert.equal(view.items.length, 0);
  const sourceId = view.sources[0].id;
  await service.run('setSource', { sourceId, selected: true, readOnly: true });
  view = await service.run('state', dates);
  const [item] = view.items;
  assert.equal(item.canDelete, false);
  await assert.rejects(service.run('remove', item), /read-only/);
  await service.run('hide', item);
  const recovered = new CalendarService(profile, registry);
  assert.equal((await recovered.run('state', dates)).items.length, 0);
  await recovered.run('restore', item);
  assert.equal((await recovered.run('state', dates)).items[0].id, 'meeting');
});

test('an unclear create is retained across restart and a different source action cannot replay it', async () => {
  const { dates, profile, service, registry, remote } = workspace();
  let calls = 0;
  remote.create = async () => { calls++; throw Object.assign(new Error('No ID returned'), { code: 'UNCERTAIN' }); };
  await service.run('connect', { provider: 'ticktick' });
  const sourceId = (await service.run('state', dates)).sources[0].id;
  await service.run('setSource', { sourceId, selected: true });
  const draft = { sourceId, title: 'Review', allDay: true, ...dates };
  await assert.rejects(service.run('save', draft), /No ID/);
  const recovered = new CalendarService(profile, registry);
  const [unclear] = (await recovered.run('state', dates)).uncertain;
  assert.equal(unclear.title, 'Review');
  await assert.rejects(recovered.run('save', draft), /unconfirmed/);
  await assert.rejects(recovered.run('disconnect', { connectionId: unclear.connectionId }), /unconfirmed/);
  assert.equal(calls, 1);
  await recovered.run('acknowledge', { id: unclear.id });
  assert.equal((await recovered.run('state', dates)).uncertain.length, 0);
});

test('a failed refresh retains cached items and attributes freshness to the covered date range', async () => {
  const { dates, service, remote } = workspace();
  await service.run('connect', { provider: 'google' });
  const sourceId = (await service.run('state', dates)).sources[0].id;
  await service.run('setSource', { sourceId, selected: true });
  const loaded = await service.run('state', dates);
  remote.items = () => { throw new Error('Calendar offline'); };
  const stale = await service.run('state', dates);
  assert.deepEqual(stale.items, loaded.items);
  assert.equal(stale.health[0].state, 'stale');
  assert.equal(stale.health[0].checkedAt, loaded.health[0].checkedAt);
  const unseen = await service.run('state', { start: '2027-02-12', end: '2027-02-13' });
  assert.equal(unseen.health[0].state, 'error');
  assert.equal(unseen.health[0].checkedAt, null);
});
