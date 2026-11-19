import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalendarService } from '../desktop/calendar-service.mjs';
import { createGoogle } from '../desktop/providers/google.mjs';

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

test('unavailable sources keep their selection and read-only policy for rediscovery after restart', async () => {
  const { dates, profile, service, registry, remote } = workspace();
  const discover = remote.sources;
  await service.run('connect', { provider: 'google' });
  const [source] = (await service.run('state', dates)).sources;
  await service.run('setSource', { sourceId: source.id, selected: true, readOnly: true });

  remote.sources = async () => [];
  const unavailable = await service.run('state', dates);
  assert.deepEqual(unavailable.sources, []);
  assert.deepEqual(unavailable.items, []);

  remote.sources = discover;
  const restoredProfile = { ...profile, data: JSON.parse(JSON.stringify(profile.data)) };
  const restored = new CalendarService(restoredProfile, registry);
  const view = await restored.run('state', dates);
  assert.equal(view.sources[0].id, source.id);
  assert.equal(view.sources[0].selected, true);
  assert.equal(view.sources[0].readOnly, true);
  assert.equal(view.items[0].canDelete, false);
});

test('refreshes the provider date range after a system time-zone change', async () => {
  const { dates, registry, service } = workspace();
  const startTimes = [];
  let clients = 0;
  registry.client = () => {
    clients++;
    return createGoogle({
      getAccessToken: async () => 'synthetic',
      fetchImpl: async url => {
        const request = new URL(url);
        if (request.pathname.endsWith('/calendarList')) {
          return Response.json({ items: [{ id: 'copy', summary: 'Work', accessRole: 'owner' }] });
        }
        startTimes.push(request.searchParams.get('timeMin'));
        return Response.json({ kind: 'calendar#events', items: [] });
      },
    });
  };

  const timeZone = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    await service.run('connect', { provider: 'google' });
    const [source] = (await service.run('state', dates)).sources;
    await service.run('setSource', { sourceId: source.id, selected: true });
    await service.run('state', dates);
    assert.equal(clients, 1);

    process.env.TZ = 'Europe/Berlin';
    await service.run('state', dates);
    assert.deepEqual(startTimes, ['2026-11-19T05:00:00.000Z', '2026-11-18T23:00:00.000Z']);
    assert.equal(clients, 2);
  } finally {
    if (timeZone === undefined) delete process.env.TZ;
    else process.env.TZ = timeZone;
  }
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

test('waiting for browser consent allows the current calendar to keep working', async () => {
  const { dates, service, registry } = workspace();
  const { promise, resolve } = Promise.withResolvers();
  registry.authorize = () => promise;
  const connecting = service.run('connect', { provider: 'ticktick' });
  try {
    const view = await service.run('state', dates);
    assert.equal(view.connections.length, 0);
  } finally {
    resolve({});
  }
  await connecting;
  assert.equal((await service.run('state', dates)).connections.length, 1);
});

test('TickTick reconnect replaces a rotated token and keeps the account, choices and local state', async () => {
  const { dates, profile, registry, remote, service } = workspace();
  const projects = {
    'old-token': ['planning', 'shared'],
    'rotated-token': ['planning', 'shared', 'new-list'],
    'other-saved-token': ['household', 'shared'],
    'different-token': ['different', 'shared'],
  };
  registry.authorize = async input => ({ token: input.token || 'rotated-token', clientId: 'same-desktop-client' });
  registry.identity = (_provider, secret) => secret.token;
  registry.client = (_provider, { token }) => ({
    sources: async () => [{ id: 'inbox', name: 'Inbox', writable: true, inbox: true },
      ...projects[token].map(id => ({ id, name: id, writable: true }))],
    items: remote.items,
  });

  await service.run('connect', { provider: 'ticktick', token: 'old-token', name: 'Planning' });
  await service.run('connect', { provider: 'ticktick', token: 'other-saved-token', name: 'Household' });
  const initial = await service.run('state', dates);
  const connectionId = initial.connections[0].id;
  const sourceId = initial.sources.find(source => source.name === 'planning').id;
  await service.run('setSource', { sourceId, selected: true, readOnly: true });
  const [item] = (await service.run('state', dates)).items;
  await service.run('hide', item);

  await service.run('connect', { provider: 'ticktick', connectionId });
  const restored = new CalendarService(profile, registry);
  const view = await restored.run('state', dates);
  assert.deepEqual(view.connections, initial.connections);
  const source = view.sources.find(entry => entry.id === sourceId);
  assert.equal(source.selected, true);
  assert.equal(source.readOnly, true);
  assert.equal(view.sources.find(entry => entry.name === 'new-list').selected, false);
  assert.deepEqual(view.items, []);
  assert.equal(view.hidden[0].id, item.id);
  assert.equal(profile.data.connections[0].secret.token, 'rotated-token');
  assert.equal(profile.data.connections[1].secret.token, 'other-saved-token');

  await assert.rejects(restored.run('connect', { provider: 'ticktick', connectionId, token: 'other-saved-token' }), /already connected/);
  await assert.rejects(restored.run('connect', { provider: 'ticktick', connectionId, token: 'different-token' }), /could not match the task lists/);
  assert.deepEqual(profile.data.connections.map(entry => entry.secret.token), ['rotated-token', 'other-saved-token']);
});

test('TickTick reconnect cannot overwrite a grant saved while consent was open', async () => {
  const { dates, profile, registry, service } = workspace();
  const slow = Promise.withResolvers();
  registry.identity = (_provider, secret) => secret.token;
  registry.authorize = async ({ token }) => {
    if (token === 'slow-token') await slow.promise;
    return { token };
  };
  await service.run('connect', { provider: 'ticktick', token: 'old-token' });
  const connectionId = (await service.run('state', dates)).connections[0].id;
  const pending = service.run('connect', { provider: 'ticktick', connectionId, token: 'slow-token' });
  await service.run('connect', { provider: 'ticktick', connectionId, token: 'new-token' });
  slow.resolve();
  await assert.rejects(pending, /changed during sign-in/);
  assert.equal(profile.data.connections[0].secret.token, 'new-token');
  assert.equal((await service.run('state', dates)).connections[0].id, connectionId);
});

test('a published TickTick Inbox ID can confirm an account or reject a different one', async () => {
  const { dates, registry, remote, service } = workspace();
  registry.authorize = async ({ token }) => ({ token });
  registry.identity = (_provider, { token }) => token;
  registry.client = (_provider, { token }) => ({
    sources: async () => [{ id: token === 'wrong-account' ? 'inbox9876' : 'inbox1234', name: 'Inbox', writable: true, inbox: true },
      ...(token === 'new-token' ? [] : [{ id: 'shared', name: 'Shared', writable: true }])],
    items: remote.items,
  });
  await service.run('connect', { provider: 'ticktick', token: 'old-token' });
  const { sources, connections } = await service.run('state', dates);
  const connectionId = connections[0].id;
  const sourceId = sources.find(source => source.name === 'Inbox').id;
  await service.run('setSource', { sourceId, selected: true });
  await assert.rejects(service.run('connect', { provider: 'ticktick', connectionId, token: 'wrong-account' }), /could not match/);
  await service.run('connect', { provider: 'ticktick', connectionId, token: 'new-token' });
  const view = await service.run('state', dates);
  assert.deepEqual(view.connections, connections);
  assert.equal(view.sources[0].id, sourceId);
  assert.equal(view.sources[0].selected, true);
});

test('additional Google accounts reuse a previously configured desktop app ID', async () => {
  const { dates, registry, service } = workspace();
  const authorizations = [];
  registry.authorize = async ({ clientId, clientSecret }) => {
    authorizations.push(clientId);
    return { clientId, clientSecret };
  };
  await service.run('connect', { provider: 'google', clientId: 'my-desktop-app', clientSecret: 'test-desktop-value' });
  assert.equal((await service.run('state', dates)).connectionOptions.googleBrowser, true);
  await service.run('connect', { provider: 'google' });
  assert.deepEqual(authorizations, ['my-desktop-app', 'my-desktop-app']);
  assert.doesNotMatch(JSON.stringify(await service.run('state', dates)), /my-desktop-app|test-desktop-value/);
});
