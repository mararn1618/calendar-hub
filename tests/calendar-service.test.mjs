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

const tickList = (id, details = {}) => ({ id, name: id, writable: true, ...details });

async function tickTickAccount(lists) {
  const workspaceData = workspace();
  const { dates, service, remote, profile } = workspaceData;
  const reads = [];
  remote.sources = async () => structuredClone(lists);
  remote.items = async source => {
    reads.push(source.id);
    return [{ id: 'task-' + source.id, title: source.name, ...dates, allDay: true,
      version: 'one', canEdit: true, canComplete: true }];
  };
  await service.run('connect', { provider: 'ticktick', name: 'Personal tasks' });
  const connectionId = profile.data.connections[0].id;
  return { ...workspaceData, reads, connectionId, sourceId: id => JSON.stringify([connectionId, id]) };
}

test('one TickTick calendar includes current and new active lists, with independent inclusion and visibility', async () => {
  const lists = [tickList('studio'), tickList('inbox'), tickList('closed', { writable: false, archived: true })];
  const { dates, service, profile, connectionId, sourceId, reads } = await tickTickAccount(lists);
  const state = () => service.run('state', dates);
  const initial = await state();
  const [calendar] = initial.ticktickCalendars;
  assert.equal(initial.ticktickCalendars.length, 1);
  assert.equal(calendar.name, 'Personal tasks');
  assert.equal(calendar.visible, true);
  assert.deepEqual(calendar.sourceIds, ['inbox', 'studio'].map(sourceId));
  assert.deepEqual(reads, ['inbox', 'studio']);
  assert.equal(initial.connections[0].ticktick.includesAll, true);
  assert.equal(initial.sources[0].inbox, true);
  assert.equal(initial.sources[2].included, false);
  assert.equal(initial.sources[2].archived, true);

  await service.run('setTickTickCalendarVisible', { connectionId, calendarId: calendar.id, visible: false });
  lists.push(tickList('new'));
  reads.length = 0;
  const hidden = await state();
  assert.deepEqual(reads, []);
  assert.deepEqual(hidden.items, []);
  assert.deepEqual(hidden.ticktickCalendars[0].sourceIds, ['inbox', 'studio', 'new'].map(sourceId));
  assert.equal(hidden.sources.find(source => source.id === sourceId('new')).included, true);
  assert(profile.data.sources.every(source => !source.selected));
  await assert.rejects(service.run('save', { sourceId: sourceId('studio'), title: 'Task', ...dates, allDay: true }), /unselected/);

  const includedSourceIds = ['studio', 'closed'].map(sourceId);
  await service.run('configureTickTick', { connectionId, includedSourceIds });
  assert.deepEqual((await state()).items, []);
  await service.run('setTickTickCalendarVisible', { connectionId, calendarId: calendar.id, visible: true });
  lists.push(tickList('later'));
  const subset = await state();
  assert.deepEqual(subset.items.map(item => item.sourceId), includedSourceIds);
  assert.deepEqual(subset.connections[0].ticktick.includedSourceIds, includedSourceIds);
  assert.equal(subset.connections[0].ticktick.includesAll, false);
  assert.equal(subset.items.find(item => item.sourceId === sourceId('closed')).canEdit, false);
});

test('old TickTick selections migrate before discovery with unavailable lists and local records intact', async () => {
  const lists = [tickList('inbox'), tickList('chosen'), tickList('other')];
  const { dates, service, profile, registry, connectionId, sourceId } = await tickTickAccount(lists);
  await service.run('state', dates);
  const previous = structuredClone(profile.data);
  delete previous.connections[0].ticktick;
  for (const source of previous.sources) {
    delete source.included;
    delete source.calendarId;
    delete source.localReadOnly;
    source.selected = source.id === sourceId('chosen');
    source.readOnly = source.selected;
  }
  previous.unavailableSourceSettings[sourceId('temporarily-gone')] = { selected: true, readOnly: true };
  previous.hidden = [{ sourceId: sourceId('chosen'), id: 'task-chosen', title: 'chosen' }];
  previous.journal = [{ id: 'uncertain', connectionId, sourceId: sourceId('chosen'), targetId: 'task-chosen', kind: 'update' }];
  const recovered = new CalendarService({ ...profile, data: previous }, registry);
  const cache = previous.cache[sourceId('chosen')];
  lists.push(tickList('temporarily-gone'), tickList('just-added'));
  const view = await recovered.run('state', dates);
  assert.deepEqual(view.connections[0].ticktick.includedSourceIds, ['chosen', 'temporarily-gone'].map(sourceId));
  assert.equal(view.ticktickCalendars[0].visible, true);
  assert.deepEqual(view.items.map(item => item.sourceId), [sourceId('temporarily-gone')]);
  assert(view.sources.filter(source => source.selected).every(source => source.readOnly));
  assert.equal(previous.cache[sourceId('chosen')], cache);
  assert.deepEqual(view.hidden, previous.hidden);
  assert.deepEqual(view.uncertain.map(record => record.id), ['uncertain']);
  assert.deepEqual(previous.sources.filter(source => source.selected).map(source => source.id), ['chosen', 'temporarily-gone'].map(sourceId));
});

test('an old TickTick account with nothing selected stays off until the account is shown', async () => {
  const lists = [tickList('inbox'), tickList('projects')];
  const { profile, registry, dates, connectionId, sourceId, reads } = await tickTickAccount(lists);
  delete profile.data.connections[0].ticktick;
  for (const source of profile.data.sources) source.selected = false;
  const service = new CalendarService(profile, registry);
  const view = await service.run('state', dates);
  const [calendar] = view.ticktickCalendars;
  assert.equal(calendar.visible, false);
  assert.equal(view.connections[0].ticktick.includesAll, true);
  assert.deepEqual(view.items, []);
  assert.deepEqual(reads, []);
  await service.run('setTickTickCalendarVisible', { connectionId, calendarId: calendar.id, visible: true });
  assert.deepEqual((await service.run('state', dates)).items.map(item => item.sourceId), ['inbox', 'projects'].map(sourceId));
});

test('native folder order, identity and visibility follow rediscovery, renames, moves and pauses in folder metadata', async () => {
  const early = '9007199254740992', late = '9007199254740993';
  const folder = { id: 'folder', name: 'Work', sortOrder: early };
  const lists = [tickList('root-a', { sortOrder: late }),
    tickList('child-b', { groupId: folder.id, folder, sortOrder: late }),
    tickList('no-order'), tickList('root-b', { sortOrder: late }),
    tickList('child-a', { groupId: folder.id, folder, sortOrder: early }), tickList('inbox')];
  const { dates, service, profile, registry, connectionId, sourceId } = await tickTickAccount(lists);
  await service.run('configureTickTick', { connectionId, mode: 'folders' });
  const first = await service.run('state', dates);
  assert.deepEqual(first.sources.map(source => source.name), ['inbox', 'child-a', 'child-b', 'root-a', 'no-order', 'root-b']);
  const [unfiled, work] = first.ticktickCalendars;
  assert.equal(unfiled.name, 'Unfiled lists');
  assert.deepEqual(work.sourceIds, ['child-a', 'child-b'].map(sourceId));
  assert.deepEqual(first.sources[1].folder, folder);
  assert.equal(first.sources[1].sortOrder, early);
  await service.run('setTickTickCalendarVisible', { connectionId, calendarId: work.id, visible: false });

  lists.reverse();
  folder.name = 'Work renamed';
  const renamed = await service.run('state', dates);
  assert.deepEqual(renamed.sources.filter(source => source.name.startsWith('root-')).map(source => source.name), ['root-b', 'root-a']);
  const hidden = renamed.ticktickCalendars.find(row => row.id === work.id);
  assert.equal(hidden.name, folder.name);
  assert.equal(hidden.color, work.color);
  assert.equal(hidden.visible, false);
  assert(!renamed.items.some(item => item.sourceId === sourceId('child-a')));

  const children = lists.filter(list => list.groupId);
  lists.splice(0, lists.length, ...lists.filter(list => !list.groupId));
  assert.equal((await service.run('state', dates)).ticktickCalendars.length, 1);
  const restored = new CalendarService({ ...profile, data: structuredClone(profile.data) }, registry);
  for (const child of children) delete child.folder;
  lists.push(...children);
  const back = await restored.run('state', dates);
  assert.deepEqual(back.ticktickCalendars.find(row => row.id === work.id), hidden);
  const moved = children[0];
  moved.groupId = null;
  const changed = await restored.run('state', dates);
  const movedSource = changed.sources.find(source => source.id === sourceId(moved.id));
  assert.equal(movedSource.groupId, null);
  assert.equal(movedSource.folder, undefined);
  assert.equal(movedSource.calendarId, unfiled.id);
  assert.equal(movedSource.selected, true);
});

test('custom calendars partition included lists and keep all writes on the original list', async () => {
  const lists = ['inbox', 'studio', 'home', 'other'].map(id => tickList(id));
  const { dates, service, profile, registry, remote, connectionId, sourceId, reads } = await tickTickAccount(lists);
  const groups = [{ id: 'a', name: 'Focus', sourceIds: ['studio', 'home'].map(sourceId) },
    { id: 'b', name: 'Personal', sourceIds: [sourceId('inbox')] }];
  await service.run('configureTickTick', { connectionId, mode: 'custom', groups });
  const view = await service.run('state', dates);
  const [focus, personal, remainder] = view.ticktickCalendars;
  assert.deepEqual(view.ticktickCalendars.map(row => row.name), ['Focus', 'Personal', 'Personal tasks']);
  assert.deepEqual(view.ticktickCalendars.flatMap(row => row.sourceIds).sort(), view.sources.map(source => source.id).sort());
  assert.notEqual(focus.color, personal.color);
  assert.deepEqual(reads, lists.map(list => list.id));
  assert.deepEqual(remainder.sourceIds, [sourceId('other')]);
  const calls = [];
  remote.create = async (list, draft) => { calls.push(['create', list.id]); return { ...draft, id: 'new-task' }; };
  remote.update = async (list, task, draft) => { calls.push(['update', list.id, task.id]); return { ...task, ...draft }; };
  remote.complete = async (list, task) => { calls.push(['complete', list.id, task.id]); };
  const item = view.items.find(item => item.sourceId === sourceId('studio'));
  const draft = { ...dates, allDay: true, title: 'New' };
  await assert.rejects(service.run('save', { ...draft, sourceId: focus.id }), /unavailable/);
  await service.run('save', { ...draft, sourceId: sourceId('home') });
  await service.run('save', { ...item, title: 'Changed' });
  await service.run('complete', item);
  assert.deepEqual(calls, [['create', 'home'], ['update', 'studio', 'task-studio'], ['complete', 'studio', 'task-studio']]);

  await service.run('setTickTickCalendarVisible', { connectionId, calendarId: focus.id, visible: false });
  const edited = [{ ...groups[0], name: 'Focused work' }, groups[1]];
  await service.run('configureTickTick', { connectionId, groups: edited, includedSourceIds: ['home', 'other'].map(sourceId) });
  const restored = new CalendarService({ ...profile, data: structuredClone(profile.data) }, registry);
  const saved = await restored.run('state', dates);
  assert.deepEqual(saved.ticktickCalendars[0], { ...focus, name: 'Focused work', visible: false, sourceIds: [sourceId('home')] });
  assert.deepEqual(saved.items.map(item => item.sourceId), [sourceId('other')]);
  await restored.run('configureTickTick', { connectionId, includedSourceIds: null });
  lists.push(tickList('new-list'));
  const all = await restored.run('state', dates);
  assert.deepEqual(all.ticktickCalendars.find(row => row.id === remainder.id).sourceIds, ['other', 'new-list'].map(sourceId));
  assert.deepEqual(all.ticktickCalendars[0].sourceIds, groups[0].sourceIds);
  assert.equal(all.ticktickCalendars[0].visible, false);
});

test('split calendars have separate accents that survive reordering, restart and renames', async () => {
  const lists = ['work', 'personal', 'archive', 'clients', 'family', 'study', 'appointments']
    .map(id => tickList(id, { groupId: id, folder: { id, name: id } }));
  lists.push(tickList('inbox'));
  const { service, dates, profile, registry, connectionId } = await tickTickAccount(lists);
  await service.run('configureTickTick', { connectionId, mode: 'folders' });
  const { ticktickCalendars } = await service.run('state', dates);
  const original = new Map(ticktickCalendars.map(calendar => [calendar.id, calendar.color]));
  assert.equal(new Set(original.values()).size, lists.length);
  lists.reverse();
  for (const list of lists) if (list.folder) list.folder.name += ' renamed';
  const restored = new CalendarService({ ...profile, data: structuredClone(profile.data) }, registry);
  const next = await restored.run('state', dates);
  for (const calendar of next.ticktickCalendars) assert.equal(calendar.color, original.get(calendar.id));
});

test('the generic and published TickTick Inbox keep the same selection and provider write route', async () => {
  const lists = [tickList('inbox', { inbox: true }), tickList('project')];
  const { service, dates, connectionId, sourceId, remote } = await tickTickAccount(lists);
  await service.run('configureTickTick', { connectionId, includedSourceIds: [sourceId('inbox')] });
  const targets = [];
  remote.create = async (source, draft) => { targets.push(source.id); return { ...draft, id: 'new' }; };
  for (const id of ['inbox1234', 'inbox']) {
    lists[0].id = id;
    const view = await service.run('state', dates);
    assert.deepEqual(view.ticktickCalendars[0].sourceIds, [sourceId('inbox')]);
    assert.equal(view.sources.filter(source => source.inbox).length, 1);
    await service.run('save', { ...dates, allDay: true, title: 'New', sourceId: sourceId('inbox') });
  }
  assert.deepEqual(targets, ['inbox1234', 'inbox1234']);
});

test('TickTick settings reject foreign sources, overlapping assignments and invalid toggles atomically', async () => {
  const { dates, service, registry, profile, connectionId, sourceId } = await tickTickAccount([tickList('studio')]);
  registry.identity = () => 'second-account';
  await service.run('connect', { provider: 'ticktick', name: 'Second account' });
  const before = await service.run('state', dates);
  const foreign = before.sources.find(source => source.connectionId !== connectionId);
  const group = { id: 'a', name: 'Work', sourceIds: [sourceId('studio')] };
  for (const fields of [
    { includedSourceIds: [foreign.id] }, { mode: 'unknown' }, { groups: [{ ...group, name: '   ' }] },
    { groups: [group, { ...group, id: 'b' }] }, { groups: [group, { ...group, sourceIds: [] }] },
    { groups: [{ ...group, sourceIds: [foreign.id] }] },
  ]) await assert.rejects(service.run('configureTickTick', { connectionId, mode: 'custom', ...fields }));
  await assert.rejects(service.run('setTickTickCalendarVisible', { connectionId, calendarId: foreign.calendarId, visible: false }), /from this TickTick account/);
  await assert.rejects(service.run('setTickTickCalendarVisible', { connectionId, calendarId: sourceId('studio'), visible: false }));
  const after = await service.run('state', dates);
  assert.deepEqual(after.connections, before.connections);
  assert.deepEqual(after.ticktickCalendars, before.ticktickCalendars);
  assert(profile.data.sources.every(source => source.selected));
});

test('TickTick limits parallel reads and coalesces matching refreshes up to the next mutation', async () => {
  const lists = Array.from({ length: 28 }, (_, index) => tickList('list-' + index));
  const { service, remote, dates, connectionId } = await tickTickAccount(lists);
  const reads = [], gate = Promise.withResolvers(), started = Promise.withResolvers();
  let active = 0, peak = 0;
  remote.items = async source => {
    reads.push(source.id);
    active++;
    peak = Math.max(active, peak);
    if (active === 4) started.resolve();
    await gate.promise;
    active--;
    return [];
  };
  const first = service.run('state', dates);
  await started.promise;
  assert.equal(service.run('state', dates), first);
  const change = service.run('configureTickTick', { connectionId, includedSourceIds: [] });
  const afterChange = service.run('state', dates);
  gate.resolve();
  const oldView = await first;
  await change;
  assert(oldView.sources.every(source => source.selected));
  assert((await afterChange).sources.every(source => !source.selected));
  assert.equal(peak, 4);
  assert.deepEqual(reads, lists.map(list => list.id));
});

test('TickTick preference changes reuse range health and only fetch lists without recent coverage', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-19T11:00:00Z') });
  const lists = Array.from({ length: 54 }, (_, index) => tickList('list-' + index));
  const { service, registry, remote, dates, connectionId, sourceId, profile } = await tickTickAccount(lists);
  const selected = lists.slice(0, 50).map(list => sourceId(list.id));
  const calls = { tickDiscovery: 0, googleDiscovery: 0, googleItems: 0, tickItems: [] };
  const originalItems = remote.items;
  let failing = false;
  remote.sources = async () => {
    calls.tickDiscovery++;
    if (failing) throw new Error('List directory offline');
    return structuredClone(lists);
  };
  remote.items = async source => {
    calls.tickItems.push(source.id);
    if (source.id === 'list-1' || (failing && source.id === 'list-2')) throw new Error('List offline');
    return originalItems(source);
  };
  registry.client = provider => provider === 'ticktick' ? remote : {
    sources: async () => { calls.googleDiscovery++; return [{ id: 'google', name: 'Meetings', writable: true }]; },
    items: async () => { calls.googleItems++; return []; },
  };
  await service.run('configureTickTick', { connectionId, includedSourceIds: selected });
  await service.run('connect', { provider: 'google' });
  await service.run('setSource', { sourceId: profile.data.sources.find(source => source.provider === 'google').id, selected: true });
  await service.run('state', dates);
  t.mock.timers.tick(60_000);
  failing = true;
  const full = await service.run('state', dates);
  const checked = full.health.find(entry => entry.sourceId === sourceId('list-2'));
  assert.equal(checked.state, 'stale');
  assert.equal(full.health.find(entry => entry.sourceId === sourceId('list-1')).state, 'error');
  assert(full.health.some(entry => !entry.sourceId && entry.message === 'List directory offline'));
  const previous = structuredClone(calls);
  const local = { ...dates, preferencesOnly: true };
  t.mock.timers.tick(30_000);
  await service.run('configureTickTick', { connectionId, mode: 'folders' });
  const sameRange = await service.run('state', local);
  assert.deepEqual(sameRange.health, full.health);
  assert.deepEqual(calls, previous);

  const calendarId = sameRange.ticktickCalendars[0].id;
  await service.run('setTickTickCalendarVisible', { connectionId, calendarId, visible: false });
  assert.deepEqual((await service.run('state', local)).items, []);
  await service.run('setTickTickCalendarVisible', { connectionId, calendarId, visible: true });
  await service.run('configureTickTick', { connectionId, includedSourceIds: [...selected, sourceId('list-50')] });
  const newlyShown = await service.run('state', local);
  assert.deepEqual(calls, { ...previous, tickItems: [...previous.tickItems, 'list-50'] });
  assert.deepEqual(newlyShown.health.find(entry => entry.sourceId === checked.sourceId), checked);
  assert(newlyShown.items.some(item => item.sourceId === sourceId('list-50')));

  await service.run('configureTickTick', { connectionId, includedSourceIds: selected.slice(1) });
  await service.run('state', local);
  t.mock.timers.tick(6 * 60_000);
  await service.run('configureTickTick', { connectionId, includedSourceIds: selected });
  await service.run('state', local);
  assert.deepEqual(calls.tickItems.slice(previous.tickItems.length), ['list-50', 'list-0']);
  assert.equal(calls.googleDiscovery, previous.googleDiscovery);
  assert.equal(calls.googleItems, previous.googleItems);
  assert.equal(calls.tickDiscovery, previous.tickDiscovery);

  failing = false;
  const cached = service.run('state', local);
  const refresh = service.run('state', dates);
  assert.notEqual(cached, refresh);
  await cached;
  const current = await refresh;
  assert.equal(current.health.find(entry => entry.sourceId === checked.sourceId).state, 'current');
  assert.equal(calls.googleDiscovery, previous.googleDiscovery + 1);
  assert.equal(calls.googleItems, previous.googleItems + 1);
  assert.equal(calls.tickDiscovery, previous.tickDiscovery + 1);
  assert.equal(calls.tickItems.length, previous.tickItems.length + 2 + selected.length);
});

test('reopened TickTick lists regain their provider permissions and explicit local locks survive rediscovery', async () => {
  const lists = [tickList('archived', { archived: true, writable: false }), tickList('locked', { writable: false })];
  const { service, profile, registry, remote, dates, sourceId } = await tickTickAccount(lists);
  let created = 0;
  remote.create = async (source, draft) => { created++; return { ...draft, id: 'created' }; };
  await service.run('setSource', { sourceId: sourceId('locked'), readOnly: true });
  remote.sources = async () => [];
  await service.run('state', dates);
  remote.sources = async () => lists.map(list => ({ ...list, archived: false, writable: true }));
  const restored = new CalendarService({ ...profile, data: structuredClone(profile.data) }, registry);
  const view = await restored.run('state', dates);
  assert(view.sources.every(source => source.selected && source.writable));
  const draft = { title: 'Reopened', allDay: true, ...dates };
  await restored.run('save', { ...draft, sourceId: sourceId('archived') });
  await assert.rejects(restored.run('save', { ...draft, sourceId: sourceId('locked') }), /read-only/);
  assert.equal(created, 1);
});

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

test('saved overlapping dates are readable during a slow refresh after restarting', async () => {
  const { service, profile, remote, registry, dates } = await tickTickAccount([tickList('work')]);
  const week = { start: '2026-11-16', end: '2026-11-23' };
  const items = [
    { id: 'today', title: 'Today', allDay: true, ...dates },
    { id: 'tomorrow', title: 'Tomorrow', allDay: true, start: dates.end, end: '2026-11-21' },
  ];
  remote.items = async () => items;
  await service.run('state', week);
  const restarted = new CalendarService({ ...profile, data: structuredClone(profile.data) }, registry);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let reads = 0;
  remote.items = async () => {
    reads++;
    started.resolve();
    await release.promise;
    return [];
  };
  const refreshing = restarted.run('state', dates);
  await started.promise;
  try {
    const cached = await Promise.race([
      restarted.run('state', { ...week, cachedOnly: true }),
      new Promise(resolve => setImmediate(resolve)),
    ]);
    assert(cached, 'Reading saved items must not wait behind a provider refresh.');
    assert.deepEqual(cached.items.map(item => item.id), ['today', 'tomorrow']);
    assert.equal(cached.rangeCovered, true);
    const nextDay = await restarted.run('state', { start: dates.end, end: '2026-11-21', cachedOnly: true });
    assert.deepEqual(nextDay.items.map(item => item.id), ['tomorrow']);
    const unseen = await restarted.run('state', { start: week.end, end: '2026-11-24', cachedOnly: true });
    assert.equal(unseen.rangeCovered, false);
    assert.deepEqual(unseen.items, []);
    assert.equal(reads, 1);
  } finally {
    release.resolve();
    await refreshing;
  }
  const updated = await restarted.run('state', { ...week, cachedOnly: true });
  assert.deepEqual(updated.items.map(item => item.id), ['tomorrow'], 'The older week must reflect the deletion found by the day refresh.');
  assert.equal(reads, 1);
});

test('cached views keep shared event IDs separate after hiding, deleting and selecting calendars', async () => {
  const { service, profile, registry, remote, dates } = workspace();
  registry.authorize = async ({ name }) => ({ name });
  registry.identity = (_provider, secret) => secret.name;
  await service.run('connect', { provider: 'google', name: 'Home' });
  await service.run('connect', { provider: 'google', name: 'Team' });
  const [home, team] = profile.data.sources;
  for (const source of [home, team]) await service.run('setSource', { sourceId: source.id, selected: true });
  const live = await service.run('state', dates);
  const week = { start: '2026-11-16', end: '2026-11-23', cachedOnly: true };
  const visible = async () => (await service.run('state', week)).items.map(item => item.sourceId);
  remote.items = () => { throw new Error('Offline'); };
  remote.remove = async () => {};
  assert.deepEqual(await visible(), [home.id, team.id]);
  await service.run('hide', live.items[0]);
  assert.deepEqual(await visible(), [team.id]);
  await service.run('remove', live.items[1]);
  assert.deepEqual(await visible(), []);
  await service.run('restore', live.items[0]);
  assert.deepEqual(await visible(), [home.id]);
  await service.run('setSource', { sourceId: home.id, selected: false });
  assert.deepEqual(await visible(), []);
});

test('cached views show interrupted and uncertain writes while an active save stays out of recovery', async () => {
  const { service, profile, registry, remote, dates } = workspace();
  await service.run('connect', { provider: 'google' });
  const [source] = profile.data.sources;
  await service.run('setSource', { sourceId: source.id, selected: true });
  const [item] = (await service.run('state', dates)).items;
  const earlier = { id: 'earlier', sourceId: source.id, connectionId: source.connectionId, targetId: 'other',
    kind: 'update', title: 'Other appointment', startedAt: '2026-11-19T08:00:00.000Z' };
  profile.data.journal.push(earlier);
  const started = Promise.withResolvers(), reply = Promise.withResolvers();
  remote.update = async () => { started.resolve(); return reply.promise; };
  const saving = assert.rejects(service.run('save', { ...item, title: 'Changed meeting' }), { code: 'UNCERTAIN' });
  await started.promise;
  const pending = profile.data.journal.find(entry => entry.targetId === item.id);
  const cached = { ...dates, cachedOnly: true };
  try {
    assert(pending);
    const during = await Promise.race([service.run('state', cached), new Promise(resolve => setImmediate(resolve))]);
    assert.deepEqual(during?.uncertain, [earlier]);
    const reopened = new CalendarService({ ...profile, data: structuredClone(profile.data) }, registry);
    assert.deepEqual((await reopened.run('state', cached)).uncertain.map(entry => entry.id), [earlier.id, pending.id]);
  } finally {
    reply.reject(Object.assign(new Error('Connection lost during save.'), { code: 'UNCERTAIN' }));
    await saving;
  }
  const failed = (await service.run('state', cached)).uncertain;
  assert.deepEqual(failed.map(entry => entry.id), [earlier.id, pending.id]);
  assert.equal(failed[1].message, 'Connection lost during save.');
});

test('cached coverage combines adjacent dates and keeps items from profiles without recorded time zones', async () => {
  const { service, remote, dates, profile, registry } = await tickTickAccount([tickList('work')]);
  await service.run('state', dates);
  remote.items = async () => [];
  await service.run('state', { start: dates.end, end: '2026-11-21' });
  const twoDays = { start: dates.start, end: '2026-11-21', cachedOnly: true };
  assert.equal((await service.run('state', twoDays)).rangeCovered, true);
  assert.equal((await service.run('state', { ...twoDays, end: '2026-11-22' })).rangeCovered, false);

  const old = structuredClone(profile.data);
  for (const check of Object.values(old.cache)[0].checks) delete check.zone;
  const restored = new CalendarService({ ...profile, data: old }, registry);
  const saved = await restored.run('state', twoDays);
  assert.equal(saved.rangeCovered, false);
  assert.deepEqual(saved.items.map(item => item.id), ['task-work']);
});

test('offline rolling views report the oldest needed check across dates in the current time zone', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T08:00:00Z') });
  const { service, remote, profile, sourceId } = await tickTickAccount([tickList('work')]);
  const monday = { start: '2026-11-16', end: '2026-11-17' };
  const tuesday = { start: monday.end, end: '2026-11-18' };
  const both = { start: monday.start, end: tuesday.end };
  remote.items = async () => [];
  const firstDay = await service.run('state', monday);
  t.mock.timers.tick(600_000);
  await service.run('state', tuesday);
  remote.items = async () => { throw new Error('Offline'); };
  const stale = await service.run('state', both);
  assert.equal(stale.rangeCovered, true);
  assert.equal(stale.health[0].state, 'stale');
  assert.equal(stale.health[0].checkedAt, firstDay.health[0].checkedAt);

  const checks = profile.data.cache[sourceId('work')].checks;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const extended = { start: monday.start, end: '2026-11-19' };
  checks.push({ ...both, zone, checkedAt: '2026-11-10T08:00:00.000Z' });
  assert.equal((await service.run('state', both)).health[0].checkedAt, firstDay.health[0].checkedAt);
  const uncovered = await service.run('state', extended);
  assert.equal(uncovered.health[0].state, 'error');
  assert.equal(uncovered.health[0].checkedAt, null);
  checks.push({ ...extended, zone: zone === 'UTC' ? 'Europe/Berlin' : 'UTC', checkedAt: new Date().toISOString() });
  const wrongZone = await service.run('state', extended);
  assert.equal(wrongZone.rangeCovered, false);
  assert.equal(wrongZone.health[0].state, 'error');
  assert.equal(wrongZone.health[0].checkedAt, null);
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
    accountInboxId: async () => ({ 'old-token': 'inbox123', 'rotated-token': 'inbox123',
      'other-saved-token': 'inbox456', 'different-token': 'inbox789' })[token],
    sources: async () => [{ id: 'inbox', name: 'Inbox', writable: true, inbox: true },
      ...projects[token].map(id => ({ id, name: id, writable: true }))],
    items: remote.items,
  });

  await service.run('connect', { provider: 'ticktick', token: 'old-token', name: 'Planning' });
  await service.run('connect', { provider: 'ticktick', token: 'other-saved-token', name: 'Household' });
  const connected = await service.run('state', dates);
  const connectionId = connected.connections[0].id;
  const sourceId = connected.sources.find(source => source.name === 'planning').id;
  await service.run('configureTickTick', { connectionId, includedSourceIds: [sourceId] });
  const other = connected.ticktickCalendars.find(calendar => calendar.connectionId !== connectionId);
  await service.run('setTickTickCalendarVisible', { connectionId: other.connectionId, calendarId: other.id, visible: false });
  await service.run('setSource', { sourceId, selected: true, readOnly: true });
  const initial = await service.run('state', dates);
  const [item] = initial.items;
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
  await assert.rejects(restored.run('connect', { provider: 'ticktick', connectionId, token: 'different-token' }), /could not verify the Inbox/);
  assert.deepEqual(profile.data.connections.map(entry => entry.secret.token), ['rotated-token', 'other-saved-token']);
});

test('TickTick reconnect cannot overwrite a grant saved while consent was open', async () => {
  const { dates, profile, registry, remote, service } = workspace();
  remote.accountInboxId = async () => 'inbox123';
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
  await assert.rejects(service.run('connect', { provider: 'ticktick', connectionId, token: 'wrong-account' }), /could not verify the Inbox/);
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

test('a list shared by two TickTick users cannot replace either account during reconnect', async () => {
  const { dates, profile, remote, registry, service } = workspace();
  registry.authorize = async ({ token }) => ({ token });
  registry.identity = (_provider, secret) => secret.token;
  remote.sources = async () => [tickList('inbox'), tickList('shared')];
  remote.accountInboxId = async () => undefined;
  await service.run('connect', { provider: 'ticktick', token: 'one' });
  const original = profile.data.connections[0];
  await assert.rejects(service.run('connect', { provider: 'ticktick', connectionId: original.id, token: 'two' }), /could not verify the Inbox/);
  assert.equal(original.secret.token, 'one');
  await service.run('connect', { provider: 'ticktick', token: 'two' });
  const view = await service.run('state', dates);
  assert.notEqual(view.connections[0].id, view.connections[1].id);
  assert.equal(view.sources.filter(source => source.name === 'shared').length, 2);
});

test('a legacy TickTick grant can reconnect using the owner of an original cached Inbox task', async () => {
  const { dates, profile, remote, registry, service } = workspace();
  registry.authorize = async ({ token }) => ({ token });
  registry.identity = (_provider, secret) => secret.token;
  remote.sources = async () => [tickList('inbox')];
  remote.items = async () => [{ id: 'previous-task', title: 'Task', ...dates, allDay: true,
    version: 'one', _ticktick: { projectId: 'inbox123' } }];
  await service.run('connect', { provider: 'ticktick', token: 'old' });
  const [connection] = (await service.run('state', dates)).connections;
  delete profile.data.connections[0].tickTickInboxId;
  let checkedDay;
  remote.accountInboxId = async day => { checkedDay = day; return 'inbox123'; };
  const restored = new CalendarService(profile, registry);
  await restored.run('connect', { provider: 'ticktick', token: 'new', connectionId: connection.id });
  assert.equal(checkedDay, dates.start);
  assert.equal(profile.data.connections[0].id, connection.id);
  assert.equal(profile.data.connections[0].secret.token, 'new');
});
