import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDesktopRegistry } from '../desktop/providers/integrations.mjs';
import { createMacCalendar } from '../desktop/providers/mac.mjs';
import { createIntegrationRegistry } from '../desktop/providers/registry.mjs';

function desktopRegistry(options = {}) {
  return createDesktopRegistry({
    testOrigin: 'http://127.0.0.1:1',
    inBrowser: () => assert.fail('Unexpected browser sign-in'),
    ...options,
  });
}

function macRegistry() {
  const google = [
    { id: 'a-main', name: 'Calendar', accountId: 'a', accountName: 'Personal', writable: true },
    { id: 'a-family', name: 'Family', accountId: 'a', accountName: 'Personal', writable: false },
    { id: 'b-main', name: 'Calendar', accountId: 'b', accountName: 'Personal', writable: true },
  ];
  const exchange = [
    { id: 'work', name: 'Calendar', accountId: 'a', accountName: 'Work', writable: true },
    { id: 'other', name: 'Calendar', accountId: 'b', accountName: 'Work', writable: true },
  ];
  return desktopRegistry({
    macCalendar: options => createMacCalendar({
      ...options,
      executeHelper: async (_executable, [action, provider]) => {
        assert.ok(['authorize', 'sources'].includes(action));
        return JSON.stringify({ google, exchange, mac: [...google, ...exchange] }[provider]);
      },
    }),
  });
}

test('one integration can authorize and create independent clients for several accounts', async () => {
  const sample = {
    id: 'sample', name: 'Sample Calendar', itemKind: 'event', routes: ['token'],
    authorize: ({ token }) => ({ token }),
    client: ({ token }) => ({ sources: () => [{ id: 'shared', accountId: token }] }),
    identity: (_secret, [source]) => source.accountId,
  };
  const registry = createIntegrationRegistry([sample]);
  assert.deepEqual(registry.connectionOptions.integrations, [
    { id: 'sample', name: 'Sample Calendar', itemKind: 'event', routes: ['token'], readOnly: false, available: true },
  ]);
  for (const token of ['a', 'b']) {
    const secret = await registry.authorize({ provider: 'sample', token });
    const sources = registry.client('sample', secret).sources();
    assert.equal(registry.identity('sample', secret, sources), token);
  }
  await assert.rejects(registry.authorize({ provider: 'unknown' }), /provider is unavailable/);
});

test('availability and routes reflect the installed integrations', async () => {
  const online = macRegistry().connectionOptions;
  assert.equal(online.googleBrowser, true);
  assert.equal(online.macCalendars, true);
  assert.deepEqual(online.integrations.map(row => [row.id, row.itemKind, row.available, row.routes]), [
    ['ticktick', 'task', true, ['browser', 'token']], ['google', 'event', true, ['browser', 'mac', 'custom']],
    ['exchange', 'event', true, ['mac']], ['mac', 'event', true, ['mac']],
  ]);
  const registry = desktopRegistry({ fixtureGoogleBrowser: false });
  const { integrations, googleBrowser, macCalendars } = registry.connectionOptions;
  assert.equal(googleBrowser, false);
  assert.equal(macCalendars, false);
  assert.deepEqual(integrations.find(row => row.id === 'google').routes, ['custom']);
  assert.deepEqual(integrations.filter(row => !row.available).map(row => [row.name, row.readOnly]),
    [['Exchange', true], ['Mac calendars', true]]);
  await assert.rejects(registry.macAccountCalendars('exchange'), /on a Mac/);
  await assert.rejects(registry.macAccountCalendars('ticktick'), /account picker/);
});

test('Google browser sign-in uses the primary calendar across token rotations and requires a verified identity', () => {
  const registry = desktopRegistry();
  const primary = { id: 'account-a@example.test', primary: true, name: 'Calendar' };
  const shared = { id: 'account-b@example.test', primary: false, name: 'Calendar' };
  const first = registry.identity('google', { refreshToken: 'one' }, [shared, primary]);
  assert.equal(first, primary.id);
  assert.equal(registry.identity('google', { refreshToken: 'two' }, [primary]), first);
  assert.notEqual(registry.identity('google', { refreshToken: 'two' }, [{ ...shared, primary: true }]), first);
  assert.throws(() => registry.identity('google', { refreshToken: 'one' }, [shared]), /primary calendar/);
});

test('restoring native accounts can list calendars without requesting access', async () => {
  const reads = [];
  const registry = desktopRegistry({
    macCalendar: ({ provider }) => ({
      authorize(options) { reads.push([provider, options]); return []; },
    }),
  });
  await registry.macAccountCalendars('google', { requestAccess: false });
  await registry.macAccountCalendars('exchange', { requestAccess: false });
  await registry.macAccountCalendars('google');
  assert.deepEqual(reads, [['google', { requestAccess: false }], ['exchange', { requestAccess: false }], ['google', undefined]]);
});

test('TickTick retains the token identity stored by existing profiles', async () => {
  const registry = desktopRegistry();
  const expected = createHash('sha256').update('personal-token').digest('hex');
  const secret = await registry.authorize({ provider: 'ticktick', route: 'token', token: ' personal-token ' });
  assert.deepEqual(secret, { token: 'personal-token' });
  assert.equal(registry.identity('ticktick', secret, [{ id: 'inbox', inbox: true }]), expected);
  await assert.rejects(registry.authorize({ provider: 'ticktick', route: 'token', token: ' ' }), /enter your TickTick/i);
});

test('Google on Mac binds selected calendars to the verified account identifier', async () => {
  const registry = macRegistry();
  const input = { provider: 'google', route: 'mac', accountId: 'a', googleCalendarIds: ['a-main', 'a-main'] };
  const first = await registry.authorize(input);
  assert.deepEqual(first, { route: 'mac', accountId: 'a', googleCalendarIds: ['a-main'] });
  assert.deepEqual((await registry.client('google', first).sources()).map(row => row.id), ['a-main']);
  const changed = await registry.authorize({ ...input, googleCalendarIds: ['a-family'] });
  const other = await registry.authorize({ ...input, accountId: 'b', googleCalendarIds: ['b-main'] });
  assert.equal(registry.identity('google', first, []), registry.identity('google', changed, []));
  assert.notEqual(registry.identity('google', first, []), registry.identity('google', other, []));
  await assert.rejects(registry.authorize({ ...input, accountId: 'Personal' }), /account is unavailable/);
  await assert.rejects(registry.authorize({ ...input, googleCalendarIds: ['a-main', 'b-main'] }), /selected calendars/);
  await assert.rejects(registry.authorize({ ...input, googleCalendarIds: [] }), /at least one/);
});

test('an existing aggregate Mac connection can be edited using its original account key', async () => {
  const registry = macRegistry();
  const input = { provider: 'google', route: 'mac', googleCalendarIds: ['a-main', 'b-main'] };
  const old = { route: 'mac', googleCalendarIds: ['a-main', 'b-main'] };
  assert.deepEqual((await registry.client('google', old).sources()).map(row => row.id), old.googleCalendarIds);
  await assert.rejects(registry.authorize(input), /Choose your Google account/);
  await assert.rejects(registry.authorize({ ...input, connectionId: 'old', legacyMac: true }), /Choose your Google account/);
  await assert.rejects(registry.authorize(input, { legacyMac: true }), /Choose your Google account/);
  const updated = await registry.authorize({ ...input, connectionId: 'old' }, { legacyMac: true });
  assert.deepEqual(updated, old);
  assert.equal(registry.identity('google', updated, []), 'google-via-apple-calendar');
  await assert.rejects(registry.authorize({ ...input, connectionId: 'old', googleCalendarIds: ['gone'] }, { legacyMac: true }), /selected calendars/);
});

test('native Google edits retain saved offline calendars for scoped and legacy connections', async () => {
  const registry = macRegistry();
  for (const legacyMac of [false, true]) {
    const input = { provider: 'google', route: 'mac', connectionId: 'saved', ...(!legacyMac && { accountId: 'a' }) };
    const context = { legacyMac, savedGoogleCalendarIds: ['offline', 'a-main'] };
    for (const requested of [['a-family'], ['a-family', 'offline']]) {
      const secret = await registry.authorize({ ...input, googleCalendarIds: requested }, context);
      assert.deepEqual(secret.googleCalendarIds, ['offline', 'a-family']);
    }
    const offline = await registry.authorize({ ...input, googleCalendarIds: [] }, context);
    assert.deepEqual(offline.googleCalendarIds, ['offline']);
    await assert.rejects(registry.authorize({ ...input, googleCalendarIds: ['unknown'] }, context), /selected calendars/);
  }
  const scoped = { provider: 'google', route: 'mac', accountId: 'a', googleCalendarIds: ['offline'] };
  const context = { savedGoogleCalendarIds: ['offline'] };
  await assert.rejects(registry.authorize(scoped, context), /selected calendars/);
  await assert.rejects(registry.authorize({ ...scoped, connectionId: 'saved', savedGoogleCalendarIds: ['offline'] }), /selected calendars/);
  await assert.rejects(registry.authorize({ ...scoped, accountId: 'gone', connectionId: 'saved' }, context), /account is unavailable/);
});

test('Exchange discovers and connects each native account separately with read-only sources', async () => {
  const registry = macRegistry();
  const candidates = await registry.macAccountCalendars('exchange');
  assert.deepEqual(candidates.map(row => [row.id, row.accountId, row.accountName, row.writable]),
    [['work', 'a', 'Work', false], ['other', 'b', 'Work', false]]);
  const keys = [];
  for (const { accountId, id } of candidates) {
    const secret = await registry.authorize({ provider: 'exchange', route: 'mac', accountId });
    assert.deepEqual(secret, { route: 'mac', accountId });
    const sources = await registry.client('exchange', secret).sources();
    assert.deepEqual(sources.map(row => row.id), [id]);
    keys.push(registry.identity('exchange', secret, sources));
    assert.notEqual(registry.identity('google', secret, sources), keys.at(-1));
    assert.throws(() => registry.identity('exchange', secret, []), /no longer available/);
  }
  assert.notEqual(keys[0], keys[1]);
  await assert.rejects(registry.authorize({ provider: 'exchange', route: 'mac' }), /Choose your Exchange account/);
  await assert.rejects(registry.authorize({ provider: 'exchange', route: 'mac', accountId: 'missing' }), /account is unavailable/);
  assert.deepEqual(await registry.authorize({ provider: 'mac' }), {});
  assert.equal(registry.identity('mac', {}, []), 'this-mac');
});
