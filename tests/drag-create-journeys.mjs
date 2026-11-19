import assert from 'node:assert/strict';

const studioId = 'studio@example.test';

function shift(day, days) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function emptyPoint(page, day, time) {
  const cell = page.locator(`.${time ? 'day-column' : 'all-day-cell'}[data-date="${day}"]`);
  const bounds = await cell.boundingBox();
  assert(bounds, 'Expected a cell for ' + day);
  const x = bounds.x + bounds.width / 2;
  let y = bounds.y + bounds.height / 2;
  if (time) {
    const [hour, minute] = time.split(':').map(Number);
    const line = value => cell.locator('.hour-line[data-time="' + String(value).padStart(2, '0') + ':00"]').first().boundingBox();
    const [start, next] = await Promise.all([line(hour), line(hour + 1)]);
    assert(start && next, 'Expected surrounding hour lines for ' + time);
    y = start.y + (next.y - start.y) * minute / 60;
  }
  const point = { x, y };
  assert(await cell.evaluate((node, sample) => document.elementFromPoint(sample.x, sample.y) === node, point),
    'The pointer must be over an empty calendar cell for ' + day + (time ? ' ' + time : '') + '.');
  return point;
}

async function drag(page, start, end, during) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await during();
  } finally {
    await page.mouse.up();
  }
}

function previews(page) {
  return page.locator('#timeline .drag-preview');
}

async function expectPreview(page, days) {
  for (const day of days) await page.locator(`[data-date="${day}"] > .drag-preview`).waitFor({ state: 'visible' });
  assert.equal(await previews(page).count(), days.length);
  assert.equal(await page.locator('dialog[open]').count(), 0, 'An editor opened before the pointer was released.');
}

export async function drawTimedAppointment(page, day, from, to, capturePreview) {
  const start = await emptyPoint(page, day, from);
  const end = await emptyPoint(page, day, to);
  await drag(page, start, end, async () => {
    await expectPreview(page, [day]);
    if (capturePreview) await capturePreview();
  });
  return page.getByRole('dialog', { name: 'New appointment', exact: true });
}

async function expectDraft(page, { startDay, endDay = startDay, startTime, endTime, allDay = false }) {
  const draft = page.getByRole('dialog', { name: 'New appointment', exact: true });
  await draft.waitFor();
  await previews(page).first().waitFor({ state: 'detached' });
  assert.equal(await draft.getByLabel('Title', { exact: true }).inputValue(), '');
  assert.equal(await draft.getByLabel('All day', { exact: true }).isChecked(), allDay);
  assert.equal(await draft.getByLabel('Start date', { exact: true }).inputValue(), startDay);
  assert.equal(await draft.getByLabel('End date', { exact: true }).inputValue(), endDay);
  const destination = draft.getByLabel('Calendar', { exact: true });
  assert.deepEqual(await destination.locator('option').allTextContents(), ['Studio']);
  assert.equal(await destination.locator('option:checked').textContent(), 'Studio');
  if (!allDay) {
    assert.equal(await draft.getByLabel('Start time', { exact: true }).inputValue(), startTime);
    assert.equal(await draft.getByLabel('End time', { exact: true }).inputValue(), endTime);
  }
  return draft;
}

async function cancelDraft(draft) {
  await draft.getByRole('button', { name: 'Cancel', exact: true }).click();
  await draft.waitFor({ state: 'hidden' });
}

export async function verifyDragCreateJourneys({ page, provider, refresh, screenshot }) {
  const day = provider.day;
  const timeline = page.locator('#timeline');
  const writesFrom = provider.controls.requests.length;
  const writes = () => provider.controls.requests.slice(writesFrom).filter(({ provider, method, path }) =>
    method !== 'GET' && !(provider === 'ticktick' && method === 'POST' && path === 'task/undone'));
  await page.locator('#today').click();

  const near = await emptyPoint(page, day, '08:12');
  const far = await emptyPoint(page, day, '09:04');
  const times = { startDay: day, startTime: '08:15', endTime: '09:00' };

  await drag(page, near, { ...near, y: near.y + 2 }, async () => {
    assert.equal(await previews(page).count(), 0);
  });
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Small pointer movement opened a draft.');

  await drag(page, far, near, async () => {
    await expectPreview(page, [day]);
    await page.keyboard.press('Escape');
    await previews(page).first().waitFor({ state: 'detached' });
  });
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Releasing after Escape opened a draft.');

  await drag(page, far, near, async () => {
    await expectPreview(page, [day]);
    const header = await page.locator('#range-title').boundingBox();
    assert(header, 'Expected the date heading outside the calendar grid.');
    await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2, { steps: 12 });
    await previews(page).first().waitFor({ state: 'detached' });
  });
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Releasing outside the grid opened a draft.');

  await drag(page, far, near, () => expectPreview(page, [day]));
  await cancelDraft(await expectDraft(page, times));
  assert.deepEqual(writes(), [], 'The cancelled timed drafts sent a provider write.');

  await page.locator('[data-view="next"]').click();
  const count = page.getByLabel('Number of days', { exact: true });
  const previousCount = await count.inputValue();
  await count.fill('4');
  await count.press('Tab');
  await refresh(page);
  assert.equal(await timeline.locator('.day-column').count(), 4);
  const next = shift(day, 1), later = shift(day, 2), last = shift(day, 3);
  await drag(page, await emptyPoint(page, last, '08:12'), await emptyPoint(page, later, '09:04'),
    () => expectPreview(page, [later, last]));
  await cancelDraft(await expectDraft(page, { startDay: later, endDay: last, startTime: '09:00', endTime: '08:15' }));

  await drag(page, await emptyPoint(page, last), await emptyPoint(page, next), async () => {
    await expectPreview(page, [next, later, last]);
    await screenshot(page, 'drag-create-all-day-preview');
  });
  await cancelDraft(await expectDraft(page, { startDay: next, endDay: last, allDay: true }));

  await count.fill(previousCount);
  await count.press('Tab');
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await page.locator('#today').click();
  await refresh(page);
  assert.deepEqual(writes(), [], 'The cancelled range drafts sent a provider write.');

  const title = 'Studio appointment from a drawn time range';
  const studio = provider.events.get(studioId);
  try {
    await drawTimedAppointment(page, day, '08:12', '09:04', () => screenshot(page, 'drag-create-timed-preview'));
    const draft = await expectDraft(page, times);
    await draft.getByLabel('Title', { exact: true }).fill(title);
    await screenshot(page, 'drag-create-appointment');
    assert.deepEqual(writes(), [], 'Opening and filling a draft sent a provider write.');
    await draft.getByRole('button', { name: 'Save', exact: true }).click();
    await draft.waitFor({ state: 'hidden' });
    const item = timeline.getByRole('button', { name: title, exact: true });
    await item.waitFor();
    const events = [...studio.values()].filter(event => event.summary === title);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.start.dateTime, new Date(day + 'T08:15:00').toISOString());
    assert.equal(event.end.dateTime, new Date(day + 'T09:00:00').toISOString());
    assert.equal(Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime), 45 * 60_000);
    assert.equal(await item.getAttribute('data-item-id'), event.id);
    assert.deepEqual(writes().map(({ provider, method, path }) => ({ provider, method, path })), [
      { provider: 'google', method: 'POST', path: 'calendars/' + studioId + '/events' },
    ]);
  } finally {
    for (const [id, event] of studio) {
      if (event.summary === title) studio.delete(id);
    }
  }
  await refresh(page);
  await timeline.getByRole('button', { name: title, exact: true }).waitFor({ state: 'detached' });
  return page;
}
