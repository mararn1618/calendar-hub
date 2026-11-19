import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appointmentRange, createAxis, possibleInstants, timedLayout } from '../ui/dates.js';

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

function timedPoint(day, time, occurrence = 0) {
  const instant = possibleInstants(day, time)[occurrence];
  assert.ok(Number.isFinite(instant));
  return { day, allDay: false, instant };
}

test('drawing in either direction snaps both times to the nearest quarter hour', () => {
  const day = '2026-11-19';
  const first = timedPoint(day, '08:19');
  const last = timedPoint(day, '09:04');
  const expected = { allDay: false, start: '2026-11-19T07:15:00.000Z', end: '2026-11-19T08:00:00.000Z' };
  assert.deepEqual(appointmentRange(first, last), expected);
  assert.deepEqual(appointmentRange(last, first), expected);
});

test('a short drag draws one quarter hour and stays within the day at midnight', () => {
  const day = '2026-11-19';
  for (const [from, to, start, end] of [
    ['08:59', '09:05', '09:00', '09:15'],
    ['09:05', '08:59', '08:45', '09:00'],
    ['00:06', '00:01', '00:00', '00:15'],
    ['23:54', '23:59', '23:45', '24:00']
  ]) {
    const range = appointmentRange(timedPoint(day, from), timedPoint(day, to));
    assert.equal(Date.parse(range.start), Date.parse(day + 'T' + start));
    assert.equal(Date.parse(range.end), Date.parse(day + 'T' + end));
  }
});

test('an overnight drag previews the same split interval in both columns', () => {
  const first = timedPoint('2026-11-19', '22:04');
  const last = timedPoint('2026-11-20', '07:39');
  const range = appointmentRange(last, first);
  const axis = createAxis([first.day, last.day]);
  const [evening] = timedLayout([range], first.day, axis);
  const [morning] = timedLayout([range], last.day, axis);
  assert.deepEqual([evening.from, evening.to], [22 * 60, 24 * 60]);
  assert.deepEqual([morning.from, morning.to], [0, 7 * 60 + 45]);
  assert.deepEqual(range, appointmentRange(first, last));
});

test('drawing across an offset change keeps the two actual instants from the grid', () => {
  const spring = '2026-03-29';
  const forward = appointmentRange(timedPoint(spring, '01:43'), timedPoint(spring, '03:17'));
  assert.deepEqual(forward, { allDay: false, start: '2026-03-29T00:45:00.000Z', end: '2026-03-29T01:15:00.000Z' });

  const autumn = '2026-10-25';
  const earlier = timedPoint(autumn, '02:27', 0);
  const later = timedPoint(autumn, '02:27', 1);
  const fall = appointmentRange(later, earlier);
  assert.deepEqual(fall, { allDay: false, start: '2026-10-25T00:30:00.000Z', end: '2026-10-25T01:30:00.000Z' });
});

test('all-day drags include both dates and only accept endpoints in the same row', () => {
  const first = { day: '2026-10-31', allDay: true };
  const last = { day: '2026-11-02', allDay: true };
  const expected = { allDay: true, start: first.day, end: '2026-11-03' };
  assert.deepEqual(appointmentRange(first, last), expected);
  assert.deepEqual(appointmentRange(last, first), expected);
  assert.deepEqual(appointmentRange(first, first), { allDay: true, start: first.day, end: '2026-11-01' });
  assert.equal(appointmentRange(first, timedPoint(first.day, '12:00')), null);
  assert.equal(appointmentRange(first, null), null);
});
