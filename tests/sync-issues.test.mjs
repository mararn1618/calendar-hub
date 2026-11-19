import assert from 'node:assert/strict';
import test from 'node:test';
import { syncIssues } from '../ui/sync-issues.js';

const tickTick = { id: 'tasks', provider: 'ticktick', providerName: 'TickTick', name: 'Personal' };
const google = { id: 'events', provider: 'google', providerName: 'Google Calendar', name: 'Personal' };
const reason = 'TickTick reached its request limit. Try again later.';

test('a failed TickTick sync counts affected lists once and keeps their errors for the details dialog', () => {
  const health = Array.from({ length: 54 }, (_, n) => ({
    connectionId: tickTick.id, sourceId: 'list-' + n, state: 'stale', message: reason
  }));
  health.push({ connectionId: tickTick.id, state: 'error', message: reason });
  health.push({ connectionId: tickTick.id, sourceId: 'other', state: 'current' });
  const { summary, accounts } = syncIssues({ health, connections: [tickTick] });
  assert.equal(summary, 'TickTick · Personal couldn’t refresh 54 lists. ' + reason);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].entries.length, 55);
  assert.equal(accounts[0].entries[53].sourceId, 'list-53');
});

test('similarly named accounts have separate sync details that clear when they recover', () => {
  const connections = [tickTick, google];
  const health = [
    { connectionId: tickTick.id, sourceId: 'one', state: 'stale', message: reason },
    { connectionId: google.id, state: 'error', message: 'Reconnect to Google.' },
  ];
  const { summary, accounts } = syncIssues({ health, connections });
  assert.equal(summary, 'Calendar updates are delayed for 2 accounts.');
  assert.deepEqual(accounts.map(group => group.label), ['Personal (TickTick)', 'Personal (Google Calendar)']);
  assert.deepEqual(accounts.map(group => group.entries[0].message), [reason, 'Reconnect to Google.']);
  health[0].state = 'current';
  assert.equal(syncIssues({ health, connections }).summary, 'Personal (Google Calendar) couldn’t refresh its calendars. Reconnect to Google.');
  health[1].state = 'current';
  assert.deepEqual(syncIssues({ health, connections }), { accounts: [], summary: '' });
});

test('Mac accounts and reminders share one access instruction when TickTick also limits requests', () => {
  const connections = [
    { id: 'home', provider: 'google', route: 'mac', providerName: 'Google Calendar', name: 'Home' },
    { id: 'work', provider: 'exchange', route: 'mac', providerName: 'Exchange', name: 'Work' },
    tickTick,
  ];
  const denied = { code: 'CALENDAR_ACCESS', message: 'Full calendar access is required.' };
  const health = [
    { connectionId: 'home', sourceId: 'personal', state: 'stale', ...denied },
    { connectionId: 'work', state: 'error', ...denied },
    { connectionId: 'tasks', sourceId: 'inbox', state: 'stale', code: 'RATE_LIMITED', status: 429, message: reason },
  ];
  const notificationFailures = [{ connectionId: 'work', sourceId: 'meetings', ...denied }];
  const issues = syncIssues({ connections, health, notificationFailures });
  assert.match(issues.macAccess?.message || issues.summary, /Calendar Hub.*Full Access/);
  assert.match(issues.summary, /TickTick.*limit/i);
  assert.equal(issues.accounts.length, 3);
  assert.equal(issues.accounts.find(account => account.label.includes('Work')).entries.length, 2);
});

test('a reminder-only access failure has the same recovery and Google web access stays separate', () => {
  const connections = [google, { id: 'local', provider: 'mac', name: 'On My Mac' }];
  const health = [{ connectionId: google.id, state: 'error', code: 'PERMISSION', message: 'Google denied access.' }];
  const explicitRequest = { connectionId: 'local', code: 'CALENDAR_ACCESS_NOT_REQUESTED', message: 'Calendar access has not been requested.' };
  const issues = syncIssues({ connections, health, notificationFailures: [explicitRequest] });
  assert.equal(issues.macAccess?.label, 'Allow Calendar Access');
  assert.match(issues.summary, /Google denied access/);
  assert.equal(syncIssues({ connections, health }).macAccess, undefined);
});
