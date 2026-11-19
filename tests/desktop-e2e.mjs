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
import { verifyGoogleJourneys } from './google-journeys.mjs';
import { verifyMacOnboarding } from './mac-onboarding-e2e.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const started = new Date().toISOString(), run = started.replaceAll(/[:.]/g, '-');
const evidence = join(project, 'build/verification', 'desktop-' + run);
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'calendar-central-e2e-'));
const configPath = join(temporary, 'test-config.json');
const provider = await startProviderServer();
await writeFile(configPath, JSON.stringify({ origin: provider.origin }));
const driver = new DesktopDriver({ evidenceDirectory: evidence, configPath });
const report = {
  started, app: appPath, applicationSha256: createHash('sha256').update(await readFile(join(appPath, 'Contents/Resources/app.asar'))).digest('hex'),
  os: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  arch: process.arch, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, day: provider.day,
  boundary: 'Packaged Mac app, production adapters, independent loopback TickTick and Google HTTP services, simulated browser consent for both providers, isolated profiles',
  passed: [], status: 'running'
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
  await dialog.getByRole('checkbox', { name: 'Planning tasks', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Connect Google', exact: true }).click();
  assert.equal(await dialog.getByLabel('Client ID', { exact: true }).count(), 0);
  const oauth = driver.application.waitForEvent('window');
  await dialog.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  const consent = await oauth;
  await consent.getByRole('button', { name: 'Authorize test calendars' }).click();
  const selected = dialog.getByRole('checkbox', { name: 'Studio', exact: true });
  await selected.waitFor();
  assert.equal(await selected.isChecked(), false);
  for (const name of ['Planning tasks', 'Studio', 'BMW Work', 'Read-only BMW Work']) {
    const control = dialog.getByRole('checkbox', { name, exact: true });
    await control.check();
    await until(async () => (await control.isChecked()) && await dialog.getByRole('button', { name: 'Done', exact: true }).isEnabled(), 'Source settings did not save.');
  }
  assert.equal(await dialog.getByRole('checkbox', { name: 'TickTick copies', exact: true }).isChecked(), false);
  const planning = dialog.getByRole('checkbox', { name: 'Planning tasks', exact: true });
  const planningId = await planning.getAttribute('data-source-id');
  await dialog.getByRole('button', { name: 'Reconnect', exact: true }).click();
  const reauth = driver.application.waitForEvent('window');
  await dialog.getByRole('button', { name: 'Continue with TickTick', exact: true }).click();
  await (await reauth).getByRole('button', { name: 'Authorize test tasks' }).click();
  await planning.waitFor();
  assert.equal(await planning.count(), 1);
  assert.equal(await planning.isChecked(), true);
  assert.equal(await planning.getAttribute('data-source-id'), planningId);
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
  await page.locator('[data-view="week"]').click();
  const day = provider.day;
  const monday = shift(day, -((new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7));
  await until(async () => await page.locator('.day-column').count() === 7, 'Week did not show seven days.');
  assert.deepEqual(await page.locator('.day-column').evaluateAll(nodes => nodes.map(n => n.dataset.date)), Array.from({ length: 7 }, (_, i) => shift(monday, i)));
  await driver.screenshot(page, 'full-week');
  await page.locator('[data-view="next"]').click();
  const count = page.getByLabel('Number of days');
  await count.fill('14'); await count.press('Enter'); await count.press('Tab');
  await until(async () => await page.locator('.day-column').count() === 14, 'Next X Days did not update.');
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
  await page.getByRole('button', { name: title, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Studio booking', exact: true }).waitFor();
  assert.equal(await page.locator('[data-item-id="tickcopy"]').count(), 0);
  return page;
}

try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
  let page = await driver.launch();
  for (const [name, perform] of [['Connect and select sources', onboard], ['Day, Week, Next X Days and scrolling', navigate], ['Create at both sources and restart', createBoth]]) {
    console.log(name); page = await perform(page) ?? page; report.passed.push(name);
  }
  const helpers = { provider, refresh, createItem, restart: () => driver.restart(), dragTo: options => driver.dragTo(options),
    screenshot: (page, name) => driver.screenshot(page, name) };
  console.log('TickTick planning and uncertain recovery');
  page = await verifyTickTickJourneys({ ...helpers, page });
  report.passed.push('Original TickTick schedule, resize, cross-date move and completion', 'TickTick create uncertainty and restart');
  console.log('Google edits, local hiding, deletion and stale data');
  page = await verifyGoogleJourneys({ ...helpers, page });
  report.passed.push('Google edits, guest review, occurrence and conflict', 'Hide, restore, read-only source, confirmed deletion', 'Stale cache and independent source recovery');
  assert.deepEqual(driver.errors, [], 'Unexpected renderer errors');
  await driver.close();
  console.log('Select Google accounts in Apple Calendar');
  await verifyMacOnboarding({ temporary, evidence });
  report.passed.push('Google through Apple Calendar: permission, explicit calendar selection, original edits and restart in a simulated Mac calendar store');
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
