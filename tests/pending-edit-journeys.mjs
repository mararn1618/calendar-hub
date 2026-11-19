import assert from 'node:assert/strict';
import { until } from './desktop-driver.mjs';
import { textContrast } from './calendar-color-journeys.mjs';

const studio = 'studio@example.test';
const tickPath = 'task/timed';
const eventPath = id => 'calendars/' + studio + '/events/' + id;
const dateTime = (day, time) => Date.parse(day + 'T' + time + ':00');
const byId = (page, id) => page.locator('.calendar-item[data-item-id=' + JSON.stringify(id) + ']');

async function assertInterval(card, day, start, end) {
  assert.equal(await card.count(), 1);
  assert.equal(await card.getAttribute('data-date'), day);
  const geometry = await card.evaluate((node, times) => {
    const column = node.closest('.day-column');
    const pixelAt = time => {
      const [h, m] = time.split(':').map(Number);
      const line = hour => column.querySelector('[data-time="' + String(hour).padStart(2, '0') + ':00"]').getBoundingClientRect().y;
      return line(h) + (line(h + 1) - line(h)) * m / 60;
    };
    const rect = node.getBoundingClientRect();
    return [rect.top - pixelAt(times[0]), rect.bottom - pixelAt(times[1])];
  }, [start, end]);
  assert.ok(geometry.every(offset => Math.abs(offset) <= 2), 'Card must occupy ' + start + ' to ' + end +
    '. Actual placement: ' + await card.getAttribute('aria-description') + ' (pixel offsets ' + geometry + ').');
  const description = await card.getAttribute('aria-description');
  assert.ok(description.includes(start) && description.includes(end), description);
}

function cardColors(card) {
  return card.evaluate(node => {
    const style = getComputedStyle(node);
    return [style.backgroundColor, style.borderLeftColor, style.color, style.filter, style.opacity];
  });
}

export async function assertPending(card, day, start, end, status = 'Saving changes') {
  await assertInterval(card, day, start, end);
  assert.equal(await card.getAttribute('data-write-state'), 'pending');
  assert.equal(await card.getAttribute('aria-busy'), 'true');
  assert.equal(await card.getAttribute('aria-disabled'), 'true');
  assert.ok((await card.getAttribute('aria-description')).includes(status));
  assert.ok((await card.getAttribute('title')).includes(status));
  const contrast = await textContrast(card);
  assert.ok(contrast >= 4.5, 'Pending item text contrast is ' + contrast.toFixed(2) + ':1.');
}

export async function assertSettled(card, day, start, end) {
  await until(async () => !await card.getAttribute('data-write-state') &&
    (await card.getAttribute('aria-description')).includes(start) && (await card.getAttribute('aria-description')).includes(end),
  'The calendar did not settle at ' + start + ' to ' + end + '.');
  await assertInterval(card, day, start, end);
  assert.notEqual(await card.getAttribute('aria-busy'), 'true');
  assert.notEqual(await card.getAttribute('aria-disabled'), 'true');
}

export async function withHeldWrite(controls, matches, action, whileHeld, rejection) {
  const gate = Promise.withResolvers();
  let arrived = false;
  controls.beforeWrite = call => {
    if (matches(call)) { arrived = true; return gate.promise; }
  };
  try {
    await action();
    await until(() => arrived, 'The expected provider write did not arrive.');
    await whileHeld();
  } finally {
    delete controls.beforeWrite;
    gate.resolve(rejection);
  }
}

function assertScopedTickReads(requests) {
  const reads = requests.filter(call => call.provider === 'ticktick' && call.method === 'GET');
  assert.deepEqual(reads.map(call => call.path).filter(path => !['project/planning/task/timed', 'project/planning/data'].includes(path)), [],
    'Saving one TickTick task fetched unrelated lists or metadata.');
}

export async function verifyPendingEdits({ page, provider, refresh, dragTo, screenshot }) {
  const { day, controls, originals } = provider;
  const events = provider.events.get(studio);
  const guest = 'guest-drag';
  const hold = (path, ...steps) => withHeldWrite(controls, call => call.path === path, ...steps);
  const writeCalls = (path, since = 0) => controls.requests.slice(since).filter(call => call.path === path && call.method !== 'GET');
  const task = page.getByRole('button', { name: 'Prepare interview questions', exact: true });
  const twin = page.getByRole('button', { name: 'Studio interview', exact: true });
  const readOnly = byId(page, 'bmwmeeting');
  const originalTask = structuredClone(originals.get('timed'));
  events.set('timed', { ...structuredClone(events.get('studioevent')), id: 'timed', summary: 'Studio interview' });
  events.set(guest, { ...structuredClone(events.get('meetingwithguests')), id: guest });
  try {
    await refresh(page);
    const tickId = await task.getAttribute('data-source-id');
    const googleId = await twin.getAttribute('data-source-id');
    assert.notEqual(tickId, googleId);
    const dragTask = options => dragTo({ itemId: 'timed', sourceId: tickId, day, ...options });
    const dragEvent = options => dragTo({ itemId: 'timed', sourceId: googleId, day, ...options });
    await page.mouse.move(2, 2);
    const colors = await cardColors(task);
    const firstCall = controls.requests.length;
    await hold(tickPath, () => dragTask({ hour: 13 }), async () => {
      await page.mouse.move(2, 2);
      await screenshot(page, 'ticktick-move-waiting-for-provider');
      await assertPending(task, day, '13:00', '13:45');
      assert.notDeepEqual(await cardColors(task), colors, 'Pending item must look distinct.');
      await assertSettled(twin, day, '10:00', '11:00');
      assert.equal(Date.parse(originals.get('timed').startDate), dateTime(day, '14:00'));
      await dragTask({ hour: 13, minute: 30 });
      await assertPending(task, day, '13:00', '13:45');
    });
    await assertSettled(task, day, '13:00', '13:45');
    assertScopedTickReads(controls.requests.slice(firstCall));
    assert.equal(Date.parse(originals.get('timed').startDate), dateTime(day, '13:00'));
    assert.equal(writeCalls(tickPath, firstCall).length, 1);

    await hold(tickPath, () => dragTask({ edge: 'end', hour: 14, minute: 15 }), async () => {
      await assertPending(task, day, '13:00', '14:15');
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      assert.equal(await page.locator('#timeline').getAttribute('aria-busy'), 'true');
      await assertPending(task, day, '13:00', '14:15');
      await page.locator('#next').click();
      await task.waitFor({ state: 'detached' });
      await page.locator('#today').click();
      await task.waitFor();
      await assertPending(task, day, '13:00', '14:15');
      await dragEvent({ hour: 10, minute: 15 });
      await assertPending(twin, day, '10:15', '11:15');
      await assertPending(task, day, '13:00', '14:15');
    });
    await assertSettled(task, day, '13:00', '14:15');
    await assertSettled(twin, day, '10:15', '11:15');
    assert.equal(Date.parse(originals.get('timed').dueDate), dateTime(day, '14:15'));

    await hold(tickPath, () => dragTask({ edge: 'start', hour: 12, minute: 30 }), async () => {
      await assertPending(task, day, '12:30', '14:15');
    }, 403);
    await assertSettled(task, day, '13:00', '14:15');
    const failure = page.getByRole('alert').filter({ hasText: /denied/i });
    await failure.getByRole('button', { name: 'Open latest item' }).waitFor();
    assert.equal(Date.parse(originals.get('timed').startDate), dateTime(day, '13:00'));
    await screenshot(page, 'ticktick-rejected-resize');

    const beforeGoogle = controls.requests.length;
    await hold(eventPath('timed'), () => dragEvent({ hour: 11, minute: 15 }), async () => {
      await assertPending(twin, day, '11:15', '12:15');
      await assertSettled(task, day, '13:00', '14:15');
      await assertSettled(readOnly, day, '10:30', '11:30');
      assert.equal(await readOnly.getAttribute('data-editable'), 'false');
      assert.equal(await readOnly.locator('[data-edge]').count(), 0);
      await dragTo({ itemId: 'bmwmeeting', day, hour: 12, minute: 45 });
      await assertSettled(readOnly, day, '10:30', '11:30');
      await screenshot(page, 'google-move-waiting-for-provider');
    });
    await assertSettled(twin, day, '11:15', '12:15');
    await hold(eventPath('timed'), () => dragEvent({ edge: 'start', hour: 11, minute: 30 }), async () => {
      await assertPending(twin, day, '11:30', '12:15');
    });
    await assertSettled(twin, day, '11:30', '12:15');
    assert.equal(Date.parse(events.get('timed').start.dateTime), dateTime(day, '11:30'));

    const guestCard = byId(page, guest);
    const dragGuest = () => dragTo({ itemId: guest, day, hour: 12, minute: 30 });
    const review = page.getByRole('dialog', { name: 'Review Google event change' });
    const confirm = review.getByRole('button', { name: 'Save changes' });
    await dragGuest();
    await review.waitFor();
    await assertPending(guestCard, day, '12:30', '13:30', 'Awaiting approval');
    assert.equal(await confirm.isDisabled(), true);
    await review.getByRole('button', { name: 'Cancel' }).click();
    await assertSettled(guestCard, day, '13:00', '14:00');
    assert.equal(writeCalls(eventPath(guest)).length, 0);
    await dragGuest();
    await review.getByRole('checkbox', { name: 'Notify guests' }).check();
    await hold(eventPath(guest), () => confirm.click(), async () => {
      await assertPending(guestCard, day, '12:30', '13:30');
      assert.equal(Date.parse(events.get(guest).start.dateTime), dateTime(day, '13:00'));
    });
    await assertSettled(guestCard, day, '12:30', '13:30');
    assert.equal(Date.parse(events.get(guest).start.dateTime), dateTime(day, '12:30'));
    assert.deepEqual(writeCalls(eventPath(guest)).map(call => call.query.sendUpdates), ['all']);

    assert.deepEqual(writeCalls('calendars/bmw-copy/events/bmwmeeting'), []);
    assert.deepEqual(controls.requests.slice(beforeGoogle).filter(call => call.provider === 'ticktick'), [],
      'Google event edits fetched TickTick lists.');
    const beforeUncertain = controls.requests.length;
    await hold(eventPath('timed'), () => dragEvent({ edge: 'end', hour: 12, minute: 45 }), async () => {
      await assertPending(twin, day, '11:30', '12:45');
    }, 503);
    await until(async () => await twin.getAttribute('data-write-state') === 'unconfirmed', 'Unconfirmed edit was marked as settled.');
    assert.ok((await twin.getAttribute('aria-description')).includes('Unconfirmed change'));
    await assertInterval(twin, day, '11:30', '12:45');
    await page.reload();
    await until(async () => await twin.getAttribute('data-write-state') === 'unconfirmed', 'Reload lost the unconfirmed move.');
    await assertInterval(twin, day, '11:30', '12:45');
    await page.getByRole('button', { name: 'Review writes', exact: true }).click();
    const journal = page.getByRole('dialog', { name: 'Review unconfirmed writes' });
    const entry = journal.locator('.review-entry').filter({ hasText: 'Studio interview' });
    await entry.waitFor();
    await screenshot(page, 'google-unconfirmed-resize');
    await entry.getByRole('button', { name: 'Mark reviewed' }).click();
    await page.getByRole('button', { name: 'I checked the source' }).click();
    await journal.getByRole('button', { name: 'Done' }).click();
    await assertSettled(twin, day, '11:30', '12:15');
    assert.equal(writeCalls(eventPath('timed'), beforeUncertain).length, 1);
  } finally {
    events.delete('timed');
    events.delete(guest);
    originals.set('timed', originalTask);
  }
  await refresh(page);
}
