import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPath, createItem, DesktopDriver, refresh, until } from './desktop-driver.mjs';
import { startProviderServer } from './provider-server.mjs';
import { verifyTickTickJourneys } from './ticktick-journeys.mjs';
import { verifyTickTickRequestJourney } from './ticktick-request-journey.mjs';
import { expandFolder, verifyTickTickCalendars } from './ticktick-calendars-e2e.mjs';
import { verifyGoogleJourneys } from './google-journeys.mjs';
import { verifyMacOnboarding } from './mac-onboarding-e2e.mjs';
import { verifyBrowserAccounts } from './multi-account-journeys.mjs';
import { verifyNotificationJourneys } from './notification-journeys.mjs';
import { verifyDragCreateJourneys } from './drag-create-journeys.mjs';
import { verifyPendingEdits } from './pending-edit-journeys.mjs';
import { verifyCalendarColors } from './calendar-color-journeys.mjs';
import { verifyExchangeAllDayHiding } from './exchange-hide-journeys.mjs';
import { verifyMacUsability } from './mac-usability-journeys.mjs';

const modes = ['--full', '--smoke', '--pending-edits', '--ticktick-requests'];
const [mode = '--full', ...extra] = process.argv.slice(2);
if (!modes.includes(mode) || extra.length) {
  console.error('Choose one suite from ' + modes.join(', ') + '.');
  process.exit(2);
}

const project = fileURLToPath(new URL('../', import.meta.url));
const started = new Date().toISOString(), run = started.replaceAll(/[:.]/g, '-');
const evidence = join(project, 'build/verification', 'desktop-' + run);
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'calendar-hub-e2e-'));
const configPath = join(temporary, 'test-config.json');
const provider = await startProviderServer();
await writeFile(configPath, JSON.stringify({ origin: provider.origin }));
const driver = new DesktopDriver({ evidenceDirectory: evidence, configPath });
const report = {
  started, app: appPath, applicationSha256: createHash('sha256').update(await readFile(join(appPath, 'Contents/Resources/app.asar'))).digest('hex'),
  os: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  arch: process.arch, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, day: provider.day,
  boundary: 'Packaged Mac app, production calendar adapters, loopback TickTick and Google services, simulated consent, Mac calendar store and notification center, isolated profiles',
  suite: mode.slice(2), passed: [], status: 'running'
};

function shift(day, days) {
  const date = new Date(day + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function onboard(page) {
  await page.getByRole('button', { name: 'Manage calendars', exact: true }).first().click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('button', { name: 'Connect TickTick', exact: true }).click();
  assert.equal(await dialog.getByLabel('Access token').count(), 0);
  const tickOAuth = driver.application.waitForEvent('window');
  await dialog.getByRole('button', { name: 'Continue with TickTick', exact: true }).click();
  const tickConsent = await tickOAuth;
  await tickConsent.getByRole('button', { name: 'Authorize test tasks' }).click();
  await dialog.getByRole('button', { name: 'Edit lists', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('checkbox', { name: 'Planning tasks', exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Connect Google Calendar', exact: true }).click();
  assert.equal(await dialog.getByLabel('Client ID', { exact: true }).count(), 0);
  const oauth = driver.application.waitForEvent('window');
  await dialog.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  const consent = await oauth;
  await consent.getByRole('button', { name: 'Authorize test calendars' }).click();
  const selected = dialog.getByRole('checkbox', { name: 'Studio', exact: true });
  await selected.waitFor();
  assert.equal(await selected.isChecked(), false);
  for (const name of ['Studio', 'BMW Work', 'Read-only BMW Work']) {
    const control = dialog.getByRole('checkbox', { name, exact: true });
    await control.check();
    await until(async () => (await control.isChecked()) && await dialog.getByRole('button', { name: 'Done', exact: true }).isEnabled(), 'Source settings did not save.');
  }
  assert.equal(await dialog.getByRole('checkbox', { name: 'TickTick copies', exact: true }).isChecked(), false);
  async function selectedPlanningId() {
    await dialog.getByRole('button', { name: 'Edit lists', exact: true }).click();
    await expandFolder(dialog, 'Work');
    const planning = dialog.getByRole('checkbox', { name: 'Planning tasks', exact: true });
    assert.equal(await planning.isChecked(), true);
    const id = await planning.getAttribute('data-source-id');
    assert.ok(id);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    return id;
  }
  const planningId = await selectedPlanningId();
  await dialog.locator('.connection-group').filter({ has: page.getByRole('button', { name: 'Edit lists', exact: true }) }).getByRole('button', { name: 'Reconnect', exact: true }).click();
  const reauth = driver.application.waitForEvent('window');
  await dialog.getByRole('button', { name: 'Continue with TickTick', exact: true }).click();
  await (await reauth).getByRole('button', { name: 'Authorize test tasks' }).click();
  assert.equal(await selectedPlanningId(), planningId);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await refresh(page);
  await page.getByRole('button', { name: 'Review the launch plan', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Review the launch plan', exact: true }).count(), 1);
  for (const id of ['timed', 'studioevent', 'bmwmeeting']) await page.locator('[data-item-id="' + id + '"]').waitFor();
  assert.equal(await page.locator('[data-item-id="tickcopy"]').count(), 0);
  assert.equal(await page.locator('[data-item-id="bmwmeeting"]').getAttribute('data-editable'), 'false');
  const bounds = await Promise.all(['studioevent', 'bmwmeeting'].map(id => page.locator('[data-item-id="' + id + '"]').boundingBox()));
  assert(bounds[0].x + bounds[0].width <= bounds[1].x + 2 || bounds[1].x + bounds[1].width <= bounds[0].x + 2, 'Overlaps must be independently reachable.');
  const disk = await readFile(join(temporary, 'profile/calendar.json'), 'utf8');
  for (const secret of ['fixture-tick-token', 'fixture-google-access', 'fixture-google-refresh', 'fixture-secret']) assert(!disk.includes(secret), 'Credentials appeared in plaintext.');
  await driver.screenshot(page, 'day-with-three-sources');
}

async function navigate(page) {
  const day = provider.day;
  const monday = shift(day, -((new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const release = Promise.withResolvers();
  let providerWaiting = false;
  provider.controls.beforeEventRead = () => { providerWaiting = true; return release.promise; };
  const meeting = page.locator('[data-item-id="studioevent"]');
  try {
    await page.getByRole('button', { name: 'Next 3 Days', exact: true }).waitFor();
    await page.locator('[data-view="week"]').click();
    await until(() => providerWaiting, 'The provider did not start its week refresh.');
    assert.deepEqual(await page.locator('.day-column').evaluateAll(nodes => nodes.map(n => n.dataset.date)), Array.from({ length: 7 }, (_, i) => shift(monday, i)));
    assert.equal(await meeting.getAttribute('data-date'), day);
    await driver.screenshot(page, 'full-week');
    await page.getByRole('button', { name: 'Next 3 Days', exact: true }).click();
    const count = page.getByLabel('Number of days');
    await count.fill('1');
    await page.getByRole('button', { name: 'Next 1 Day', exact: true }).waitFor();
    await count.fill('14'); await count.press('Enter'); await count.press('Tab');
    await page.getByRole('button', { name: 'Next 14 Days', exact: true }).waitFor();
    await until(async () => await page.locator('.day-column').count() === 14, 'The rolling view did not show the selected days.');
    assert.equal(await meeting.getAttribute('data-date'), day);
    assert.equal(await page.locator('#timeline').getAttribute('aria-busy'), 'true');
    await page.locator('#next').click();
    await page.locator('.day-column[data-date="' + shift(day, 14) + '"]').waitFor();
    assert.match(await page.locator('#range-summary').textContent(), /Checking for items…/);
    assert.equal(await meeting.count(), 0);
  } finally {
    delete provider.controls.beforeEventRead;
    release.resolve();
  }
  await until(async () => await page.locator('#timeline').getAttribute('aria-busy') === 'false', 'The rolling view did not finish refreshing.');
  assert.match(await page.locator('#range-summary').textContent(), /\b0 items$/);
  assert.equal(await page.locator('.day-column').count(), 14);
  await page.locator('#today').click();
  await meeting.waitFor();
  assert.equal(await page.locator('.day-column').first().getAttribute('data-date'), day);
  const view = page.locator('#timeline');
  await view.hover();
  const beforeY = await view.evaluate(node => node.scrollTop);
  await page.mouse.wheel(0, 230);
  await until(async () => (await view.evaluate(node => node.scrollTop)) > beforeY + 10, 'Vertical scroll did not move the time grid.');
  await page.mouse.wheel(280, 0);
  await until(async () => (await view.evaluate(node => node.scrollLeft)) > 50, 'Horizontal scroll did not move the date columns.');
  await driver.screenshot(page, 'rolling-view-scrolled');
  await page.locator('#next').click();
  await until(async () => await page.locator('.day-column').first().getAttribute('data-date') !== day, 'Next range did not advance.');
  await page.locator('#today').click();
  await page.locator('[data-view="day"]').click();
  await refresh(page);
  assert.equal(await page.locator('.day-column').first().getAttribute('data-date'), day);
}

async function createBoth(page) {
  const title = 'Draft the schedule';
  await createItem(page, { title, calendar: 'Planning tasks', day: provider.day });
  await page.getByRole('button', { name: title, exact: true }).waitFor();
  await createItem(page, { title: 'Studio booking', calendar: 'Studio', allDay: false, day: provider.day, hour: 12 });
  await page.getByRole('button', { name: 'Studio booking', exact: true }).waitFor();
  const task = [...provider.originals.values()].filter(item => item.title === title);
  const event = [...provider.events.get('studio@example.test').values()].filter(item => item.summary === 'Studio booking');
  assert.equal(task.length, 1); assert.equal(task[0].projectId, 'planning'); assert.equal(task[0].isAllDay, true);
  assert.equal(event.length, 1); assert.equal(new Date(event[0].start.dateTime).getHours(), 12);
  page = await driver.restart();
  await page.getByRole('button', { name: 'Next 14 Days', exact: true }).waitFor();
  assert.equal(await page.locator('[data-view="day"]').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: title, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Studio booking', exact: true }).waitFor();
  assert.equal(await page.locator('[data-item-id="tickcopy"]').count(), 0);
  return page;
}

async function verifyAppearance(page) {
  const manage = () => page.locator('#manage-calendars').click();
  const option = name => page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name, exact: true });
  const done = () => page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  const shades = { Light: 'rgb(255, 255, 255)', Dark: 'rgb(32, 33, 38)' };
  for (const [name, color] of Object.entries(shades)) {
    await manage();
    if (name === 'Light') assert.equal(await option(name).isChecked(), true);
    await option(name).check();
    await until(async () => await driver.application.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === name.toLowerCase(),
      'The native window did not adopt the selected appearance.');
    assert.equal(await page.locator('dialog').evaluate(node => getComputedStyle(node).backgroundColor), color);
    await done();
    assert.equal(await page.locator('.day-header').first().evaluate(node => getComputedStyle(node).backgroundColor), color);
    assert.equal(await page.locator('.calendar-item[data-item-id="studioevent"]').count(), 1);
    await driver.screenshot(page, 'appearance-' + name.toLowerCase());
  }
  page = await driver.restart();
  await manage();
  assert.equal(await option('Dark').isChecked(), true);
  assert.equal(await driver.application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
  await driver.screenshot(page, 'appearance-settings');
  await option('Light').check();
  await done();
  return page;
}

async function verifyRemainingJourneys(page, helpers) {
  for (const [name, perform] of [['Day, Week and rolling views during refresh and scrolling', navigate], ['Create at both sources and restart', createBoth]]) {
    console.log(name); page = await perform(page) ?? page; report.passed.push(name);
  }
  console.log('Calendar appearance and restart');
  page = await verifyAppearance(page);
  report.passed.push('Light and Dark apply from settings and the saved appearance survives restart');
  console.log('Calendar colors and contrast');
  page = await verifyCalendarColors({ ...helpers, page });
  report.passed.push('Pick and reset local calendar colors with keyboard and swatch, including contrast, timed and all-day items, hiding and restart');
  console.log('Draw appointments on the calendar');
  page = await verifyDragCreateJourneys({ ...helpers, page });
  report.passed.push('Draw timed and all-day appointment drafts, cancel without writes and save once to the selected Google calendar');
  console.log('TickTick account, list selection, folders and custom calendars');
  page = await verifyTickTickCalendars({ ...helpers, page });
  report.passed.push('One TickTick account, native folder and list order, remembered filters, folder split and named calendars writing to the original lists');
  console.log('TickTick planning and uncertain recovery');
  page = await verifyTickTickJourneys({ ...helpers, page });
  report.passed.push('Original TickTick schedule, resize, cross-date move and completion', 'TickTick create uncertainty and restart');
  console.log('Google edits, local hiding, deletion and stale data');
  page = await verifyGoogleJourneys({ ...helpers, page });
  report.passed.push('Google edits, guest review, occurrence and conflict', 'Hide, restore, read-only source, confirmed deletion', 'Stale cache and independent source recovery');
  console.log('Per-calendar system notifications and lead times');
  page = await verifyNotificationJourneys({ ...helpers, page });
  report.passed.push('Per-calendar timed notifications, permission, quick/custom leads, hidden calendars, updates, completion, mute and restart with a simulated notification center');
  assert.deepEqual(driver.errors, [], 'Unexpected renderer errors');
  await driver.close();
  console.log('Independent Google and Exchange accounts in Apple Calendar');
  await verifyMacOnboarding({ temporary, evidence });
  report.passed.push('Two Mac Google and two read-only Exchange accounts, scoped edits, independent reminders, rename, restart and disconnect');
  console.log('Hide and restore read-only Exchange all-day items');
  await verifyExchangeAllDayHiding({ temporary, evidence });
  report.passed.push('Hide individual Exchange all-day items locally, keep them hidden during refresh and restart, and restore them from Hidden items');
  console.log('Mac Calendar access recovery and collapsible sidebar');
  await verifyMacUsability({ temporary, evidence });
  report.passed.push('Open Calendar Privacy Settings from a denied first connection and resume setup after granting access',
    'One Calendar Privacy Settings action for multiple Mac calendar accounts, cached items, and recovery on returning to Calendar Hub',
    'Request Mac Calendar access only after Allow Calendar Access, offer Settings after denial, and preserve independent TickTick errors until recovery',
    'Collapse the sidebar by keyboard, keep New item, Manage calendars and Refresh reachable, and keep the layout after restart');
  console.log('Two Google and two TickTick browser accounts');
  await verifyBrowserAccounts({ temporary, evidence });
  report.passed.push('Browser sign-in to two Google and two TickTick accounts, with overlapping lists and calendars, separate writes, reconnect and restart');
}

try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
  if (mode !== '--ticktick-requests') {
    const page = await driver.launch();
    await onboard(page);
    report.passed.push('Connect and select sources');
    const helpers = { provider, refresh, createItem, restart: () => driver.restart(), dragTo: options => driver.dragTo(options),
      screenshot: (page, name) => driver.screenshot(page, name) };
    console.log('Drag and resize while the provider response is held');
    await verifyPendingEdits({ page, ...helpers });
    report.passed.push('Pending calendar edits, permission review, rejected writes and scoped TickTick requests');
    if (mode === '--full') await verifyRemainingJourneys(page, helpers);
    else await driver.close();
  }
  if (mode !== '--pending-edits') {
    console.log('TickTick request limits with 52 selected lists');
    report.tickTickRequests = await verifyTickTickRequestJourney({ temporary, evidence });
    report.passed.push('52 selected TickTick lists, bulk reads, cached tasks and reminders during a rate limit, independent Exchange updates and recovery',
      'One-minute, five-minute and manual TickTick calendars after restart, scoped automatic polling and explicit refresh');
  }
  assert.deepEqual(driver.errors, [], 'Unexpected renderer errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  if (driver.page && !driver.page.isClosed()) await driver.screenshot(driver.page, 'failure').catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await driver.close().catch(() => {}); await provider.close();
  report.finished = new Date().toISOString(); report.providerRequests = provider.controls.requests.length;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
  console.log(report.status + ' · ' + join(evidence, 'report.json'));
}
