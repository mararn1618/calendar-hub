import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createMacNotificationCenter } from '../desktop/mac-notifications.mjs';

const start = Date.parse('2030-08-18T15:00:00Z');
const reminder = (id, minutes, title = id) => ({ id, title, body: 'Sample calendar', fireAt: new Date(start + minutes * 60000).toISOString() });

function fixture() {
  const pending = new Map();
  const delivered = new Map();
  const calls = [];
  const os = { status: 'undetermined', otherPending: 0, now: start };
  const invoke = async (method, payload) => {
    calls.push({ method, payload });
    switch (method) {
      case 'authorization': return os.status;
      case 'requestAuthorization': return os.status = 'allowed';
      case 'snapshot': return { otherPending: os.otherPending, pending: [...pending.values()], delivered: [...delivered.values()] };
      case 'schedule':
        if (os.reject === payload.id) throw new Error('macOS rejected the request');
        if (os.ignore !== payload.id) pending.set(payload.id, payload);
        return;
      case 'cancel': for (const id of payload) pending.delete(id); return;
      default: assert.fail(method);
    }
  };
  const connect = () => createMacNotificationCenter({ load: () => invoke, now: () => os.now });
  return { center: connect(), connect, pending, delivered, calls, os };
}

test('Mac authorization is silent until requested and unavailable native support is visible', async () => {
  const { center, calls } = fixture();
  assert.equal(await center.authorization(), 'undetermined');
  await assert.rejects(center.replace([reminder('meeting', 5)]), /permission/);
  assert(!calls.some(call => ['requestAuthorization', 'schedule'].includes(call.method)));
  assert.equal(await center.requestAuthorization(), 'allowed');
  const unavailable = createMacNotificationCenter({ load() { throw new Error('missing addon'); } });
  assert.equal(await unavailable.authorization(), 'unavailable');
  assert.equal(await unavailable.requestAuthorization(), 'unavailable');
  await assert.rejects(unavailable.replace([]), /bridge is unavailable/);
});

test('reconciles native requests by stable ID across restarts, edits and mute', async () => {
  const { center, connect, pending, delivered, calls, os } = fixture();
  os.status = 'allowed';
  await center.replace([reminder('meeting', 5), reminder('task', 3)]);
  const first = pending.get('meeting');
  const reopened = connect();
  await reopened.replace([reminder('meeting', 5), reminder('task', 3)]);
  assert.equal(calls.filter(call => call.method === 'schedule').length, 2);
  delivered.set('task', pending.get('task'));
  pending.delete('task');
  await reopened.replace([reminder('meeting', 6, 'Rescheduled'), reminder('task', 3), reminder('past', -1)]);
  assert.deepEqual([...pending.keys()], ['meeting']);
  assert.notEqual(pending.get('meeting').signature, first.signature);
  assert.equal(pending.get('meeting').seconds, (start + 6 * 60000) / 1000);
  assert.equal(pending.get('meeting').title, 'Rescheduled');
  os.status = 'denied';
  await reopened.replace([]);
  assert.equal(pending.size, 0);
  assert.deepEqual(calls.filter(call => call.method === 'cancel').map(call => call.payload), [['meeting']]);
});

test('schedules the nearest available slots, reserves room for unrelated alerts and refills after delivery', async () => {
  const { center, pending, delivered, os } = fixture();
  os.status = 'allowed';
  os.otherPending = 2;
  const reminders = Array.from({ length: 70 }, (_, i) => reminder('task-' + i, i + 1));
  await center.replace(reminders.toReversed());
  assert.deepEqual([...pending.keys()], reminders.slice(0, 62).map(row => row.id));
  delivered.set('task-0', pending.get('task-0'));
  pending.delete('task-0');
  os.now = start + 65000;
  await center.replace(reminders);
  assert.deepEqual([...pending.keys()], reminders.slice(1, 63).map(row => row.id));
});

test('reports partial schedules, retries failed additions and serializes a concurrent mute', async () => {
  const { center, pending, calls, os } = fixture();
  os.status = 'allowed';
  os.reject = 'second';
  const rows = [reminder('first', 1), reminder('second', 2)];
  await assert.rejects(center.replace(rows), /rejected/);
  delete os.reject;
  os.ignore = 'second';
  await assert.rejects(center.replace(rows), /confirm/);
  delete os.ignore;
  await Promise.all([center.replace(rows), center.replace([])]);
  assert.equal(pending.size, 0);
  assert.equal(calls.filter(call => call.method === 'schedule' && call.payload.id === 'first').length, 1);
});

test('macOS builds a one-shot UTC trigger and cancels only its own native requests', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'calendar-central-notification-unit-'));
  const run = promisify(execFile);
  try {
    const fixture = fileURLToPath(new URL('./fixtures/mac-notification-center.mm', import.meta.url));
    const executable = join(dir, 'test-center');
    await run('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'UserNotifications', fixture, '-o', executable]);
    await run(executable);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
