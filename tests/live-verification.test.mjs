import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destinationState, inspectDestinations } from './live-destinations.mjs';
import { openProviderProbe } from './live-probe.mjs';

const title = 'Calendar Hub test synthetic item';

async function fixture(t, kind, serve) {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-live-probe-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceId = 'designated', list = 'test-list';
  const secret = kind === 'google' ? { accessToken: 'fixture', expiresAt: Date.now() + 600_000 } : { token: 'fixture' };
  const sources = [{ id: sourceId, remoteId: list, connectionId: 'one', provider: kind, selected: true, writable: true, name: 'Disposable' }];
  const connections = [{ id: 'one', provider: kind, name: 'Fixture', secret: Buffer.from(JSON.stringify(secret)).toString('base64') }];
  await writeFile(join(directory, 'calendar.json'), JSON.stringify({ sources, connections }));
  const app = { isPackaged: true, getPath: () => directory, getVersion: () => 'fixture' };
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer fixture');
    return serve(new URL(url), request);
  });
  return { inventory: inspectDestinations({ app }),
    probe: openProviderProbe({ app, safeStorage: { decryptString: bytes => bytes.toString() } }, { sourceId, kind, title }) };
}

test('the only selected writable calendar still requires explicit designation', async t => {
  const { inventory } = await fixture(t, 'google', () => assert.fail('Selection must not query a provider.'));
  assert.equal(destinationState('google', undefined, inventory).source, undefined);
  assert.equal(destinationState('google', 'test-list', inventory).source.id, 'designated');
  inventory.choices.push({ ...inventory.choices[0], id: 'other', remoteId: 'other' });
  assert.equal(destinationState('google', 'Disposable', inventory).source, undefined);
  assert.equal(destinationState('ticktick', 'Disposable', inventory).status, 'unconfigured');
});

test('TickTick metadata is seeded once by exact ID and remains verifiable after completion', async t => {
  const task = { id: 'run-task', title, projectId: 'test-list', startDate: '2026-11-10', isAllDay: true, status: 0 };
  let writes = 0;
  const { probe } = await fixture(t, 'ticktick', (url, request) => {
    if (url.pathname.endsWith('/project/test-list/task/run-task')) {
      return task.status === 2 ? new Response(null, { status: 404 }) : Response.json(task);
    }
    if (url.pathname.endsWith('/task/completed')) {
      assert.deepEqual(JSON.parse(request.body).projectIds, ['test-list']);
      return Response.json([{ ...task, id: 'unrelated' }, task]);
    }
    assert.equal(url.pathname, '/open/v1/task/run-task');
    assert.equal(request.method, 'POST');
    const body = JSON.parse(request.body);
    assert.equal(body.id, task.id);
    assert.equal(body.projectId, task.projectId);
    assert.equal(body.startDate, task.startDate);
    Object.assign(task, body);
    task.items[0].id = 'saved-checklist-id';
    writes++;
    return new Response(null, { status: 201 });
  });
  assert.equal((await probe({ id: task.id })).hasNotes, false);
  assert.equal((await probe({ id: task.id, action: 'seed' })).sent, true);
  assert.match((await probe({ id: task.id, action: 'seed' })).error, /empty/);
  assert.equal(writes, 1);
  const baseline = await probe({ id: task.id });
  assert.ok(baseline.hasNotes && baseline.hasChecklist);
  task.status = 2;
  const input = { id: task.id, action: 'completed', timing: { since: '2026-11-10T00:00:00.000+0000' } };
  const completed = await probe(input);
  assert.ok(completed.completed && completed.detailsExposed);
  assert.equal(completed.signature, baseline.signature);
  delete task.items;
  assert.equal((await probe(input)).detailsExposed, false);
});

test('external Google moves reject guests, changed baselines and other run titles before writing', async t => {
  const timing = { fromStart: '2026-11-10T10:00:00Z', fromEnd: '2026-11-10T11:00:00Z',
    toStart: '2026-11-10T12:00:00Z', toEnd: '2026-11-10T13:00:00Z' };
  const event = { id: 'run-event', summary: title, etag: '"initial"', organizer: { self: true }, status: 'confirmed',
    start: { dateTime: timing.fromStart }, end: { dateTime: timing.fromEnd } };
  let writes = 0;
  const { probe } = await fixture(t, 'google', (url, request) => {
    assert.equal(url.pathname, '/calendar/v3/calendars/test-list/events/run-event');
    if (request.method !== 'PATCH') return Response.json(event);
    assert.equal(request.headers['If-Match'], event.etag);
    assert.equal(url.searchParams.get('sendUpdates'), 'none');
    Object.assign(event, JSON.parse(request.body));
    writes++;
    return Response.json(event);
  });
  const input = { id: event.id, action: 'move', timing };
  event.attendees = [{ responseStatus: 'accepted' }];
  assert.match((await probe(input)).error, /guests/);
  delete event.attendees;
  event.summary = 'different event';
  assert.match((await probe(input)).error, /title/);
  event.summary = title;
  assert.match((await probe({ ...input, timing: { ...timing, fromEnd: timing.toEnd } })).error, /changed/);
  assert.equal(writes, 0);
  assert.equal((await probe(input)).sent, true);
  assert.equal((await probe({ id: event.id })).start, timing.toStart);
  assert.match((await probe(input)).error, /changed/);
  assert.equal(writes, 1);
});
