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
