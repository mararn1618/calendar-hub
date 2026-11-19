import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addDays } from '../ui/dates.js';
import { DesktopDriver, refresh, until } from './desktop-driver.mjs';
import { createMacCalendarFixture } from './fixtures/mac-calendar.mjs';
import { startProviderServer } from './provider-server.mjs';

function fillAccount(provider) {
  const { day, projects, originals } = provider;
  for (let n = projects.length; n < 55; n++) {
    projects.push({ id: 'list-' + n, name: 'Project ' + n, permission: 'write', groupId: 'work', closed: n >= 53 });
  }
  const at = (offset, time = '00:00') => new Date(addDays(day, offset) + 'T' + time + ':00').toISOString();
  const add = (id, projectId, dates) => originals.set(id, {
    id, projectId, title: id, isAllDay: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    status: 0, ...dates,
  });
  add('Brief deadline', 'briefs', { dueDate: at(4) });
  add('Continuous assignment', 'planning', { startDate: at(-2), dueDate: at(6) });
  add('Upcoming call', 'planning', { startDate: at(1, '13:00'), dueDate: at(1, '14:00'), isAllDay: false });
  add('Later deadline', 'errands', { dueDate: at(29) });
}

async function waitForRefresh(page, action) {
  const timeline = page.locator('#timeline');
  const count = Number(await timeline.getAttribute('data-refresh-count'));
  await action();
  await until(async () => Number(await timeline.getAttribute('data-refresh-count')) > count,
    'The calendar did not finish refreshing after the UI action.');
}

async function regainFocus(page) {
  await waitForRefresh(page, () => page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  }));
}

async function verifyRequestActivity(page, requests) {
  const total = requests.length;
  await page.getByRole('button', { name: 'Manage calendars', exact: true }).click();
  await page.getByRole('dialog', { name: 'Calendars', exact: true }).getByRole('button', { name: 'Sync details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sync details' });
  const tickReads = requests.filter(call => call.provider === 'ticktick');
  const summary = dialog.locator('summary');
  assert.equal(await summary.innerText(), 'TickTick · ' + tickReads.length + ' API requests');
  await summary.click();
  const table = dialog.getByRole('table', { name: 'TickTick request activity' });
  assert.deepEqual(await table.getByRole('columnheader').allTextContents(), ['Request', 'Count', 'Last request', 'Result']);
  for (const [path, name] of [['project', 'Lists'], ['project/group', 'Folders'], ['task/undone', 'Tasks by date']]) {
    const requestsForPath = tickReads.filter(call => call.path === path);
    assert(requestsForPath.length > 0);
    const row = table.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
    const cells = await row.getByRole('cell').allTextContents();
    assert.equal(cells[1], String(requestsForPath.length));
    assert.match(cells[2], /\d{2}:\d{2}/);
    assert.equal(cells[3], requestsForPath.at(-1).retryAt ? '429' : '200');
  }
  await table.getByText(/Last rate limit/).waitFor();
  await regainFocus(page);
  assert.equal(requests.length, total, 'Opening request activity or returning focus should use cached data.');
  assert.equal(await table.isVisible(), true, 'Request activity collapsed after a passive refresh.');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
}

async function verifyPollingIntervals({ driver, page, provider, mac, counts }) {
  const { originals, controls, day } = provider;
  const settings = () => page.getByRole('dialog', { name: 'Calendars', exact: true });
  const interval = name => settings().getByLabel('Sync interval for ' + name, { exact: true });
  const open = () => page.getByRole('button', { name: 'Manage calendars', exact: true }).click();
  const done = () => settings().getByRole('button', { name: 'Done', exact: true }).click();
  const item = title => page.getByRole('button', { name: title, exact: true }).and(page.locator('[data-date="' + day + '"]'));
  async function advanceClock(ms) {
    await driver.application.evaluate((_, offset) => process.getBuiltinModule('node:test').mock.timers.tick(offset), ms);
    await waitForRefresh(page, () => page.clock.fastForward(ms));
  }

  await open();
  assert.equal(await interval('TickTick').inputValue(), '5');
  assert.deepEqual(await interval('TickTick').locator('option').evaluateAll(options =>
    options.map(option => Number(option.value)).sort((a, b) => a - b)), [0, 1, 2, 5, 10, 15, 30, 60]);
  await done();
  await page.getByRole('button', { name: 'Edit TickTick lists', exact: true }).click();
  const groups = page.getByRole('dialog', { name: 'TickTick calendars', exact: true });
  await groups.getByRole('button', { name: 'By folder', exact: true }).click();
  await groups.getByRole('button', { name: 'Save', exact: true }).click();
  await groups.waitFor({ state: 'hidden' });
  await open();
  for (const [name, minutes] of [['Personal', '1'], ['Work', '0']]) {
    assert.equal(await interval(name).inputValue(), '5');
    await waitForRefresh(page, () => interval(name).selectOption(minutes));
  }
  await done();
  await refresh(page);
  page = await driver.restart();
  await open();
  assert.equal(await interval('Personal').inputValue(), '1');
  assert.equal(await interval('Work').inputValue(), '0');
  assert.equal(await interval('Unfiled lists').inputValue(), '5');
  await driver.screenshot(page, 'ticktick-sync-intervals');
  await done();

  await page.clock.install();
  await page.reload();
  await item('Revised launch plan').waitFor();
  await until(async () => Number(await page.locator('#timeline').getAttribute('data-refresh-count')) > 0, 'Reload did not complete.');
  await driver.application.evaluate(({ app }) => {
    const timers = process.getBuiltinModule('node:test').mock.timers;
    timers.enable({ apis: ['Date'], now: Date.now() });
    app.once('will-quit', () => timers.reset());
  });
  originals.get('errand-task').title = 'Collect the updated prints';
  originals.get('review').title = 'Revised again in Work';
  const start = controls.requests.length;
  const macReads = mac.calls.length;
  await advanceClock(61_000);
  await item('Collect the updated prints').waitFor();
  await item('Revised launch plan').waitFor();
  const calls = controls.requests.slice(start);
  assert.deepEqual(calls.map(call => [call.path, call.range?.projectIds]), [['task/undone', ['errands']]]);
  assert.equal(mac.calls.length, macReads, 'The one-minute TickTick timer contacted Exchange.');
  counts.oneMinutePoll = calls.length;

  originals.get('inbox-one').title = 'Updated inbox brief';
  await advanceClock(5 * 60_000);
  await item('Updated inbox brief').waitFor();
  await item('Revised launch plan').waitFor();
  const manualLists = new Set(provider.projects.filter(project => project.groupId === 'work').map(project => project.id));
  assert(!controls.requests.slice(start).some(call => call.range?.projectIds.some(id => manualLists.has(id))),
    'The Manual folder was polled when the default five-minute interval elapsed.');
  await refresh(page);
  await item('Revised again in Work').waitFor();
}

export async function verifyTickTickRequestJourney({ temporary, evidence }) {
  const dir = await mkdtemp(join(temporary, 'ticktick-requests-'));
  const configPath = join(dir, 'test-config.json');
  const office = { id: 'team', name: 'Team calendar', accountId: 'office', accountName: 'Office', exchange: true };
  const mac = createMacCalendarFixture([office]);
  const provider = await startProviderServer({ macCalendar: mac, multipleAccounts: true });
  const driver = new DesktopDriver({ evidenceDirectory: evidence, configPath });
  const { day, controls, projects } = provider;
  const counts = {};
  try {
    fillAccount(provider);
    const event = { id: 'meeting', title: 'Team meeting', allDay: true, start: day, end: addDays(day, 1), providerCalendarId: office.id, version: '1' };
    mac.events.set(event.id, event);
    await writeFile(configPath, JSON.stringify({ origin: provider.origin, macFixture: true }));
    const page = await driver.launch();
    provider.accounts[0].tickToken = 'fixture-large-account';
    const sizes = await page.evaluate(async ({ token, start, end }) => {
      await window.calendar.connect({ provider: 'ticktick', route: 'token', token });
      await window.calendar.connect({ provider: 'exchange', route: 'mac', accountId: 'office' });
      const { sources } = await window.calendar.state({ start, end, cachedOnly: true });
      await window.calendar.setSource({ sourceId: sources.find(s => s.provider === 'exchange').id, selected: true });
      const lists = sources.filter(s => s.provider === 'ticktick');
      return [lists.length, lists.filter(s => s.selected).length];
    }, { token: provider.accounts[0].tickToken, start: day, end: addDays(day, 1) });
    assert.deepEqual(sizes, [55, 52]);
    const selected = projects.filter(p => !p.closed).map(p => p.id === provider.accounts[0].inbox ? 'inbox' : p.id).sort();
    const requests = controls.requests;
    const card = (title, date) => page.locator('.calendar-item[data-date="' + date + '"]').getByText(title, { exact: true });
    const setDays = n => waitForRefresh(page, () => page.getByLabel('Number of days').fill(String(n)));
    function assertBatches(start, name, min, max) {
      const calls = requests.slice(start);
      counts[name] = calls.length;
      assert(calls.length >= min && calls.length <= max, name + ': ' + calls.length + ' TickTick requests');
      for (const call of calls) {
        assert.equal(call.path, 'task/undone', name + ' fetched metadata or an entire project');
        assert.deepEqual([...call.range.projectIds].sort(), selected);
      }
    }

    let before = requests.length;
    await waitForRefresh(page, () => page.locator('[data-view="next"]').click());
    await card('Read studio brief', day).waitFor();
    assertBatches(before, 'threeDayView', 1, 2);
    before = requests.length;
    await setDays(5);
    assertBatches(before, 'threeToFiveDays', 0, 0);
    for (const [title, offset, project] of [
      ['Read studio brief', 0, provider.accounts[0].inbox], ['Continuous assignment', 0, 'planning'],
      ['Continuous assignment', 4, 'planning'], ['Brief deadline', 4, 'briefs'],
    ]) {
      const item = page.getByRole('button', { name: title, exact: true }).and(page.locator('[data-date="' + addDays(day, offset) + '"]'));
      assert.equal(JSON.parse(await item.getAttribute('data-source-id'))[1], project);
    }
    before = requests.length;
    await regainFocus(page);
    assertBatches(before, 'focus', 0, 0);
    before = requests.length;
    const recover = controls.blockTickReads(8);
    provider.originals.get('review').title = 'Revised launch plan';
    await refresh(page);
    const warning = page.locator('#notices').getByText(/TickTick reached its request limit/i);
    await warning.waitFor();
    assert.match(await warning.innerText(), /Next check after .*\d{2}:\d{2}/);
    assert.equal(await page.getByRole('button', { name: 'Retry refresh', exact: true }).count(), 0);
    await card('Review the launch plan', day).waitFor();
    const blocked = requests.slice(before);
    counts.firstLimitedRefresh = blocked.length;
    assert.equal(blocked.length, 1, 'The first 429 should stop the rest of the account refresh.');
    assert(blocked[0].retryAt > Date.now());
    before = requests.length;
    await regainFocus(page);
    const bell = page.getByRole('button', { name: 'Notifications for TickTick', exact: true });
    await bell.click();
    await until(async () => await bell.getAttribute('aria-pressed') === 'true', 'TickTick reminders did not turn on.');
    await until(() => [...provider.notifications.pending.values()].some(note => note.title === 'Upcoming call'),
      'The cached task did not keep its system reminder.');
    Object.assign(event, { title: 'Rescheduled team meeting', version: '2' });
    await refresh(page);
    await card(event.title, day).waitFor();
    await card('Review the launch plan', day).waitFor();
    await warning.waitFor();
    assertBatches(before, 'focusRemindersAndRefreshDuringLimit', 0, 0);
    await driver.screenshot(page, 'ticktick-request-limit');
    await recover();
    await refresh(page);
    await card('Revised launch plan', day).waitFor();
    await warning.waitFor({ state: 'hidden' });
    assert(requests.slice(before).some(call => call.path === 'task/undone'), 'The app did not resume task reads.');
    await verifyRequestActivity(page, requests);
    before = requests.length;
    await setDays(31);
    await card('Later deadline', addDays(day, 29)).waitFor();
    assertBatches(before, 'extendedRange', 2, 4);
    await setDays(5);
    await verifyPollingIntervals({ driver, page, provider, mac, counts });
    assert.deepEqual(driver.errors, []);
    return counts;
  } catch (error) {
    if (driver.page && !driver.page.isClosed()) await driver.screenshot(driver.page, 'ticktick-request-failure').catch(() => {});
    throw error;
  } finally {
    try { await driver.close(); } finally { await provider.close(); }
  }
}
