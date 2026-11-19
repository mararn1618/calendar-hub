import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAxis, possibleInstants, timedLayout } from '../ui/dates.js';

process.env.TZ = 'Europe/Berlin';

test('the time grid and editor distinguish both occurrences of the autumn hour and omit the spring gap', () => {
  const autumn = '2026-10-25', spring = '2026-03-29';
  const fall = createAxis([autumn]), jump = createAxis([spring]);
  assert.equal(fall.minutes, 1500);
  assert.equal(jump.minutes, 1380);
  const twice = possibleInstants(autumn, '02:30');
  assert.equal(twice.length, 2);
  assert.equal(twice[1] - twice[0], 3600000);
  assert.equal(fall.position(autumn, twice[1]) - fall.position(autumn, twice[0]), 60);
  assert.deepEqual(possibleInstants(spring, '02:30'), []);
});

test('an overlapping point task remains reachable alongside a crossing appointment', () => {
  const day = '2026-11-19', axis = createAxis([day]);
  const point = { id: 'point', start: '2026-11-19T10:00:00+01:00', end: '2026-11-19T10:00:00+01:00' };
  const ongoing = { id: 'meeting', start: '2026-11-18T21:00:00+01:00', end: '2026-11-19T10:30:00+01:00' };
  const [a, b] = timedLayout([point, ongoing], day, axis);
  assert.equal(a.startsHere, false);
  assert.equal(a.columns, 2);
  assert.equal(b.columns, 2);
  assert.notEqual(a.column, b.column);
  assert(b.to > b.from);
});
