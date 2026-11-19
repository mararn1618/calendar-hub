import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const studio = 'studio@example.test';
const bmw = 'bmw-copy';

function at(day, hour, minute = 0) {
  const date = new Date(day + 'T00:00:00');
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

async function readEvent(provider, calendar, id) {
  const url = new URL('/google/calendar/v3/calendars/' + encodeURIComponent(calendar) + '/events/' + encodeURIComponent(id), provider.origin);
  assert.equal(url.hostname, '127.0.0.1');
  const response = await fetch(url, { headers: { Authorization: 'Bearer fixture-google-access' } });
  if (response.status === 404) return null;
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForEvent(provider, id, expected) {
  const deadline = Date.now() + 8_000;
  let item = await readEvent(provider, studio, id);
  while (!expected(item) && Date.now() < deadline) {
    await delay(75);
    item = await readEvent(provider, studio, id);
  }
  assert.ok(expected(item), 'Unexpected Google fixture state for ' + id + ': ' + JSON.stringify(item));
  return item;
}

const block = (page, id) => page.locator('.calendar-item[data-item-id="' + id + '"]');

async function menuFor(page, id) {
  await block(page, id).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Item actions' });
  await menu.waitFor();
  return menu;
}

export async function verifyGoogleJourneys({ page, provider, dragTo, restart, refresh, screenshot }) {
  const day = provider.day;
  const before = await readEvent(provider, studio, 'studioevent');
  await dragTo({ itemId: 'studioevent', day, hour: 11, minute: 15 });
  const moved = await waitForEvent(provider, 'studioevent', item => item?.start.dateTime === at(day, 11, 15));
  assert.equal(moved.end.dateTime, at(day, 12, 15));
  assert.equal(moved.id, before.id);
  assert.equal(moved.description, before.description);
  await refresh(page);
  await dragTo({ itemId: 'studioevent', day, hour: 12, minute: 45, edge: 'end' });
  const resized = await waitForEvent(provider, 'studioevent', item => item?.end.dateTime === at(day, 12, 45));
  assert.equal(resized.start.dateTime, moved.start.dateTime);
  assert.equal(resized.description, before.description);
  assert.deepEqual(resized.organizer, before.organizer);
  await refresh(page);

  const cases = [
    { id: 'meetingwithguests', hour: 13, label: 'Notify guests', evidence: 'google-guest-review', sendUpdates: 'all' },
    { id: 'weeklyinstance', hour: 15, label: 'Only this occurrence', evidence: 'google-occurrence-review', sendUpdates: 'none' },
  ];
  for (const { id, hour, label, evidence, sendUpdates } of cases) {
    const prior = await readEvent(provider, studio, id);
    await dragTo({ itemId: id, day, hour, minute: 30 });
    const review = page.getByRole('dialog', { name: 'Review Google event change' });
    await review.waitFor();
    const confirm = review.getByRole('button', { name: 'Save changes' });
    const check = review.getByRole('checkbox', { name: label });
    assert.equal(await check.isChecked(), false);
    assert.equal(await confirm.isDisabled(), true);
    assert.deepEqual(await readEvent(provider, studio, id), prior);
    await screenshot(page, evidence);
    await check.check();
    await confirm.click();
    const result = await waitForEvent(provider, id, item => item?.start.dateTime === at(day, hour, 30));
    assert.equal(result.description, prior.description);
    assert.deepEqual(result.attendees, prior.attendees);
    assert.deepEqual(result.originalStartTime, prior.originalStartTime);
    const patch = provider.controls.requests.findLast(call => call.method === 'PATCH' && call.path === 'calendars/' + studio + '/events/' + id);
    assert.equal(patch?.query.sendUpdates, sendUpdates);
    await review.waitFor({ state: 'hidden' });
  }
  assert.ok(!provider.controls.requests.some(call => call.method === 'PATCH' && call.path.endsWith('/events/weeklyseries')));

  await block(page, 'studioevent').click();
  const editor = page.getByRole('dialog', { name: 'Edit event' });
  await editor.getByLabel('Title', { exact: true }).fill('Local stale edit');
  const external = provider.events.get(studio).get('studioevent');
  Object.assign(external, { summary: 'Design review from Google', etag: '"501"' });
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const conflict = editor.getByRole('alert');
  await conflict.waitFor();
  assert.match(await conflict.innerText(), /changed/i);
  assert.equal((await readEvent(provider, studio, 'studioevent')).summary, 'Design review from Google');
  await screenshot(page, 'google-stale-edit');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await refresh(page);
  await page.getByRole('button', { name: 'Design review from Google', exact: true }).waitFor();

  const originalBmw = await readEvent(provider, bmw, 'bmwmeeting');
  assert.equal(await block(page, 'bmwmeeting').getAttribute('data-editable'), 'false');
  assert.equal(await block(page, 'bmwmeeting').locator('[data-edge]').count(), 0);
  let menu = await menuFor(page, 'bmwmeeting');
  assert.equal(await menu.getByRole('menuitem', { name: 'Edit item' }).count(), 0);
  assert.equal(await menu.getByRole('menuitem', { name: 'Delete from Google' }).count(), 0);
  await menu.getByRole('menuitem', { name: 'View details' }).click();
  const details = page.getByRole('dialog', { name: 'Item details' });
  await details.getByText('This item is read-only in Calendar Hub.').waitFor();
  assert.equal(await details.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  await details.getByRole('button', { name: 'Done' }).click();
  menu = await menuFor(page, 'bmwmeeting');
  await menu.getByRole('menuitem', { name: 'Hide in Calendar Hub' }).click();
  await block(page, 'bmwmeeting').waitFor({ state: 'detached' });
  assert.deepEqual(await readEvent(provider, bmw, 'bmwmeeting'), originalBmw);

  page = await restart();
  await block(page, 'studioevent').waitFor();
  assert.equal(await block(page, 'bmwmeeting').count(), 0);
  await page.locator('#hidden-items').click();
  const hidden = page.getByRole('dialog', { name: 'Hidden items' });
  const entry = hidden.locator('.review-entry').filter({ hasText: originalBmw.summary });
  await entry.waitFor();
  await screenshot(page, 'bmw-hidden-after-restart');
  await entry.getByRole('button', { name: 'Restore' }).click();
  await entry.waitFor({ state: 'detached' });
  await hidden.getByRole('button', { name: 'Done' }).click();
  await block(page, 'bmwmeeting').waitFor();
  assert.deepEqual(await readEvent(provider, bmw, 'bmwmeeting'), originalBmw);

  menu = await menuFor(page, 'studioevent');
  await menu.getByRole('menuitem', { name: 'Delete from Google' }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete from Google?' });
  await deletion.waitFor();
  assert.ok(await readEvent(provider, studio, 'studioevent'));
  await screenshot(page, 'google-delete-review');
  await deletion.getByRole('button', { name: 'Cancel' }).click();
  assert.ok(await readEvent(provider, studio, 'studioevent'));
  menu = await menuFor(page, 'studioevent');
  await menu.getByRole('menuitem', { name: 'Delete from Google' }).click();
  await deletion.getByRole('button', { name: 'Delete from Google' }).click();
  await waitForEvent(provider, 'studioevent', item => item === null);
  await block(page, 'studioevent').waitFor({ state: 'detached' });

  const staleIndicator = page.locator('.source-toggle').filter({ has: page.getByRole('checkbox', { name: 'BMW Work', exact: true }) })
    .locator('.health-warning[aria-label="stale"]');
  provider.controls.unavailable.add(bmw);
  Object.assign(provider.events.get(studio).get('weeklyinstance'), { summary: 'Updated weekly check-in', etag: '"601"' });
  Object.assign(provider.events.get(bmw).get('bmwmeeting'), {
    summary: 'BMW project sync moved', start: { dateTime: at(day, 12) }, end: { dateTime: at(day, 13) }, etag: '"602"',
  });
  try {
    await refresh(page);
    await staleIndicator.waitFor();
    await page.getByRole('button', { name: originalBmw.summary, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Updated weekly check-in', exact: true }).waitFor();
    await screenshot(page, 'bmw-stale-cache');
  } finally {
    provider.controls.unavailable.delete(bmw);
  }
  await refresh(page);
  await staleIndicator.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'BMW project sync moved', exact: true }).waitFor();
  const recovered = await readEvent(provider, bmw, 'bmwmeeting');
  assert.equal(recovered.start.dateTime, at(day, 12));
  assert.equal(await block(page, 'bmwmeeting').getAttribute('data-editable'), 'false');
  assert.ok(!provider.controls.requests.some(call => call.method !== 'GET' && call.path.startsWith('calendars/' + bmw + '/')));
  return page;
}
