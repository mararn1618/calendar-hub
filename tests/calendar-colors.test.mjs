import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CalendarService } from '../desktop/calendar-service.mjs';
import { Profile } from '../desktop/profile.mjs';
import { tickTickSettings } from '../desktop/ticktick-calendars.mjs';

const period = { start: '2026-11-19', end: '2026-11-20' };
const key = (account, id) => JSON.stringify([account, id]);

async function fixture(t, accounts, catalog) {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-colors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = new Profile(directory);
  profile.data.connections = accounts.map(([id, provider]) => ({ id, provider, name: id, secret: null,
    ...(provider === 'ticktick' && { ticktick: tickTickSettings(id, [], {}, true) }) }));
  profile.save();
  const calls = [];
  const registry = { client: provider => ({
    sources: async () => { calls.push('sources'); return structuredClone(catalog[provider]); },
    items: async () => { calls.push('items'); return []; },
  }) };
  const reopen = () => new CalendarService(new Profile(directory), registry);
  let service = reopen();
  return {
    state: () => service.run('state', period), run: (method, data) => service.run(method, data),
    color: (calendarId, color) => service.run('setCalendarColor', { calendarId, color }),
    restart: () => { service = reopen(); }, data: () => service.data, calls,
  };
}

test('local calendar colors follow account and calendar IDs through refresh, hiding, rediscovery and restart', async t => {
  const catalog = {
    google: [{ id: 'main', name: 'Meetings', color: '#3366aa', writable: true }, { id: 'second', name: 'Other', writable: true }],
    exchange: [{ id: 'main', name: 'Meetings', color: '#667788', writable: false }],
  };
  const app = await fixture(t, [['Home', 'google'], ['Studio', 'google'], ['Work', 'exchange']], catalog);
  const [home, studio, work] = ['Home', 'Studio', 'Work'].map(account => key(account, 'main'));
  await app.state();
  await app.run('setSource', { sourceId: home, selected: true });
  const before = app.calls.length;
  await app.color(home, '#AABB22');
  await app.color(work, '#ffffff');
  assert.equal(app.calls.length, before);
  const providerColor = catalog.google[0].color = '#cabc12';
  const from = async id => (await app.state()).sources.find(source => source.id === id);
  assert.equal((await from(studio)).color, providerColor);
  assert.equal((await from(home)).color, '#aabb22');
  assert.equal((await from(key('Home', 'second'))).hasCustomColor, undefined);
  assert.equal((await from(work)).color, '#ffffff');
  assert.equal((await from(work)).readOnly, true);
  await app.run('setSource', { sourceId: home, selected: false });
  const removed = catalog.google.shift();
  assert.equal(await from(home), undefined);
  app.restart();
  catalog.google.push(removed);
  const returned = await from(home);
  assert.equal(returned.selected, false);
  assert.equal(returned.hasCustomColor, true);
  assert.equal(returned.color, '#aabb22');
  await app.run('setSource', { sourceId: home, selected: true });
  const saved = structuredClone(app.data().calendarColorOverrides);
  for (const value of ['#fff', 'white', 'background: red', '#ff000080', 42, undefined]) {
    await assert.rejects(app.color(home, value), /six-digit hex/);
  }
  await assert.rejects(app.color('unknown', '#ffffff'), /available calendar/);
  assert.deepEqual(app.data().calendarColorOverrides, saved);
  await app.color(home, null);
  app.restart();
  assert.equal((await from(home)).color, providerColor);
  assert.equal((await from(home)).hasCustomColor, undefined);
  assert.equal((await from(work)).color, '#ffffff');
  await app.run('disconnect', { connectionId: 'Work' });
  assert.deepEqual(app.data().calendarColorOverrides, {});
});

test('TickTick modes remember separate colors for the account, folders, custom calendars and remaining lists', async t => {
  const app = await fixture(t, [['Tasks', 'ticktick']], { ticktick: [
    { id: 'inbox', name: 'Inbox', writable: true },
    { id: 'briefs', name: 'Briefs', groupId: 'studio', folder: { id: 'studio', name: 'Studio' }, color: '#123456', writable: true },
  ] });
  const configure = input => app.run('configureTickTick', { connectionId: 'Tasks', ...input });
  const calendars = async () => (await app.state()).ticktickCalendars;
  const [account] = await calendars();
  await app.color(account.id, '#c1c2c3');
  await configure({ mode: 'folders' });
  const [unfiled, folder] = await calendars();
  await app.color(unfiled.id, '#000000');
  await app.color(folder.id, '#778899');
  const group = { id: 'focus', name: 'Focus', sourceIds: [key('Tasks', 'briefs')] };
  await configure({ mode: 'custom', groups: [group] });
  const [focus, remainder] = await calendars();
  await app.color(focus.id, '#ffeedd');
  await app.color(remainder.id, '#88aabb');
  await assert.rejects(app.color(group.sourceIds[0], '#111111'), /available calendar/);
  await app.run('setTickTickCalendarVisible', { connectionId: 'Tasks', calendarId: focus.id, visible: false });
  await configure({ groups: [{ ...group, name: 'Client work' }] });
  app.restart();
  const hidden = await calendars();
  assert.deepEqual(hidden.map(row => [row.name, row.visible, row.color]), [
    ['Client work', false, '#ffeedd'], ['Tasks', true, '#88aabb'],
  ]);
  assert.equal((await app.state()).sources.find(row => row.name === 'Briefs').color, '#123456');
  await configure({ mode: 'account' });
  assert.equal((await calendars())[0].color, '#c1c2c3');
  await configure({ mode: 'folders' });
  assert.deepEqual((await calendars()).map(row => row.color), ['#000000', '#778899']);
  await app.color(folder.id, null);
  assert.equal((await calendars())[1].color, folder.color);
  await configure({ mode: 'custom', groups: [] });
  await configure({ groups: [group] });
  assert.equal((await calendars())[0].color, focus.color);
  assert.equal((await calendars())[0].hasCustomColor, undefined);
  assert.equal((await calendars())[1].color, '#88aabb');
});
