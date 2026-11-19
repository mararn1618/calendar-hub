import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appPath, DesktopDriver, createItem, refresh, until } from './desktop-driver.mjs';
import { destinationState, inspectDestinations, offerDestinations } from './live-destinations.mjs';
import { openProviderProbe } from './live-probe.mjs';

const execute = promisify(execFile);
const output = fileURLToPath(new URL('../build/verification/live/', import.meta.url));
const runId = randomUUID();
const prefix = 'Calendar Hub test ' + runId;
const title = { ticktick: prefix + ' task', google: prefix + ' appointment' };
const names = { ticktick: process.env.CALENDAR_LIVE_TICKTICK_LIST, google: process.env.CALENDAR_LIVE_GOOGLE_CALENDAR };
const kinds = ['ticktick', 'google'];
const report = {
  runId, startedAt: new Date().toISOString(), status: 'starting', stage: 'Launch the packaged Mac app',
  build: null, setup: {}, checks: [], disposableItems: {}, providers: {}, bmw: 'Exchange unconfigured',
};
const driver = new DesktopDriver({ evidenceDirectory: output, startupTimeout: 180_000 });
const probes = new Map(), destinations = {};
let page, initialView, nativeDirectory, nativeExecutable, leaveOpen = false;
let day, tomorrow, ticktickDetails;
class LiveError extends Error {}
class Incomplete extends LiveError {}
function need(condition, message) { if (!condition) throw new LiveError(message); }
const errorText = error => error instanceof LiveError ? error.message : 'The current step did not finish. Check the run-specific disposable item before retrying.';

async function saveReport() {
  await mkdir(output, { recursive: true, mode: 0o700 });
  report.updatedAt = new Date().toISOString();
  const contents = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(output, runId + '.json'), contents, { mode: 0o600 });
  const temporary = join(output, runId + '.tmp');
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, join(output, 'latest.json'));
}
async function check(name) { report.checks.push(name); await saveReport(); }
async function stage(name) { report.stage = name; await saveReport(); }

function closedDuringSetup(error) {
  const child = driver.application?.process?.();
  return page?.isClosed() || child?.exitCode != null || child?.signalCode != null ||
    /(?:target|page|browser|context|connection|application).{0,65}(?:has been closed|was closed|is closed|terminated)/i.test(error?.message || '');
}
async function recordClosedSetup(pending) {
  report.status = 'setup_closed';
  for (const kind of pending) report.providers[kind] = { status: 'not_run', reason: report.setup[kind] || 'setup closed' };
  await stage('Calendar Hub closed during live setup');
}

const settings = () => page.getByRole('dialog', { name: 'Calendars', exact: true });
const button = name => page.getByRole('button', { name, exact: true });
const time = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00');
const item = (kind, id) => button(title[kind]).and(page.locator('[data-source-id=' + JSON.stringify(destinations[kind].id) + ']' +
  (id ? '[data-item-id=' + JSON.stringify(id) + ']' : '')));
const at = (target, date, start, end) => target.and(page.locator('[data-date="' + date + '"][aria-description*="' + start + '"][aria-description*="' + end + '"]'));

async function nextDestinations(pending, timeout) {
  let deadline = Date.now() + timeout;
  do {
    const inventory = await driver.application.evaluate(inspectDestinations);
    need(!inventory.invalid, 'Use the packaged Calendar Hub app with live provider connections.');
    report.build = inventory.build;
    const states = Object.fromEntries([...pending].map(kind => [kind, destinationState(kind, names[kind], inventory)]));
    const ready = Object.fromEntries(Object.entries(states).filter(([, state]) => state.source).map(([kind, state]) => [kind, state.source]));
    const dialog = page.locator('#dialog[open]');
    if (!Object.keys(ready).length && !(await dialog.isVisible())) await page.locator('#manage-calendars').click();
    const chosen = await page.evaluate(offerDestinations, { states, named: names });
    for (const [kind, requested] of Object.entries(chosen)) {
      if (!pending.has(kind) || names[kind]) continue;
      const source = states[kind].choices.find(row => row.id === requested);
      if (source) { ready[kind] = source; states[kind].status = 'ready'; }
    }
    const before = JSON.stringify(report.setup);
    for (const [kind, state] of Object.entries(states)) report.setup[kind] = state.status;
    const inSettings = await settings().isVisible();
    const connecting = await dialog.isVisible() && (!inSettings || await settings().getAttribute('aria-busy') === 'true');
    const status = connecting ? 'pending_login' : Object.values(states).every(state => state.status === 'unconfigured') ? 'unconfigured' : 'pending_selection';
    if (before !== JSON.stringify(report.setup) || report.status !== status) {
      report.status = status;
      await stage('Waiting for live connections and explicitly designated disposable destinations');
      console.log('Live setup: ' + report.status + '. See build/verification/live/latest.json.');
    }
    if (connecting) {
      await delay(1500);
      deadline = Date.now() + timeout;
      continue;
    }
    if (Object.keys(ready).length) {
      if (inSettings) await settings().getByRole('button', { name: 'Done', exact: true }).click();
      return ready;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(1500, remaining));
  } while (true);
  leaveOpen = true;
  report.setupTimedOut = true;
  return {};
}

async function prepareNativeProbe() {
  if (nativeExecutable) return;
  nativeDirectory = await mkdtemp(join(tmpdir(), 'calendar-hub-live-'));
  const info = join(nativeDirectory, 'Info.plist');
  await writeFile(info, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
    '<key>CFBundleIdentifier</key><string>local.calendarcentral.verification.eventkit</string>' +
    '<key>CFBundleName</key><string>Calendar Hub Test</string>' +
    '<key>NSCalendarsFullAccessUsageDescription</key><string>Verify the disposable test event selected in Calendar Hub.</string>' +
    '</dict></plist>');
  const executable = join(nativeDirectory, 'Calendar Hub Test');
  const target = (process.arch === 'arm64' ? 'arm64' : 'x86_64') + '-apple-macos14.0';
  await execute('xcrun', ['swiftc', '-parse-as-library', '-target', target,
    fileURLToPath(new URL('live-eventkit.swift', import.meta.url)), '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT',
    '-Xlinker', '__info_plist', '-Xlinker', info, '-o', executable]);
  nativeExecutable = executable;
}
async function connectProbe(kind) {
  if (destinations[kind].route === 'mac') await prepareNativeProbe();
  probes.set(kind, await driver.application.evaluateHandle(openProviderProbe, {
    kind, sourceId: destinations[kind].id, title: title[kind], nativeExecutable,
  }));
}
async function probe(kind, id, action = 'read', timing) {
  const result = await probes.get(kind).evaluate((operation, input) => operation(input), { id, action, timing });
  if (result.unavailable) throw new Incomplete(result.unavailable);
  need(!result.error, 'Independent ' + kind + ' ' + action + ' failed: ' + result.error);
  return result;
}
async function read(kind, id, since) {
  const result = since ? await probe(kind, id, 'completed', { since }) : await probe(kind, id);
  if (kind === 'ticktick' && ticktickDetails && !result.missing) {
    if (result.completed) report.disposableItems.ticktick = 'completion confirmed by original ID and status 2';
    if (result.completed && !result.detailsExposed) throw new Incomplete('TickTick confirmed completion but omitted fields needed to verify the notes and checklist.');
    need(result.signature === ticktickDetails && result.hasNotes && result.hasChecklist, 'Notes or checklist changed on the original disposable task.');
  }
  return result;
}
async function closeProbes() {
  for (const handle of probes.values()) await handle.dispose().catch(() => {});
  probes.clear();
}
async function restart(kind) {
  await closeProbes();
  page = await driver.restart();
  await connectProbe(kind);
  await showTestDays();
  await refresh(page);
}
async function checkAppReceipt(kind, id) {
  const unconfirmed = await driver.application.evaluate(({ app }, row) => {
    const file = process.getBuiltinModule('path').join(app.getPath('userData'), 'calendar.json');
    const { journal } = JSON.parse(process.getBuiltinModule('fs').readFileSync(file, 'utf8'));
    return journal.some(entry => entry.sourceId === row.sourceId && entry.targetId === row.id);
  }, { sourceId: destinations[kind].id, id });
  if (unconfirmed) throw new Incomplete('The source reflects the change, but Calendar Hub retained the write for review.');
}
async function showTestDays() {
  await button('Today').click();
  await page.locator('[data-view="next"]').click();
  const count = page.getByRole('spinbutton', { name: 'Number of days' });
  if (Number(await count.inputValue()) !== 2) { await count.fill('2'); await count.press('Tab'); }
  await page.locator('.day-column[data-date="' + tomorrow + '"]').waitFor();
}

async function createOriginal(kind, allDay) {
  await stage('Create a disposable ' + kind + ' item');
  report.disposableItems[kind] = 'creation started';
  await saveReport();
  await createItem(page, { title: title[kind], calendarValue: destinations[kind].id, allDay, day, hour: 9 });
  await until(async () => {
    const review = page.getByRole('dialog', { name: 'Review unconfirmed writes' });
    if (await review.isVisible()) {
      const row = review.locator('.review-entry').filter({ has: page.getByText(title[kind], { exact: true }) });
      need(await row.count() === 1, 'A different unconfirmed write is open.');
      const noId = /without returning a task ID/i.test(await row.innerText());
      report.disposableItems[kind] = noId ? 'accepted without a confirmed ID' : 'creation unconfirmed';
      await check(kind + ' showed the run-specific unconfirmed write');
      await restart(kind);
      await button('Review writes').click();
      const reopened = page.getByRole('dialog', { name: 'Review unconfirmed writes' });
      await reopened.locator('.review-entry').filter({ has: page.getByText(title[kind], { exact: true }) }).waitFor();
      await check(kind + ' retained the unconfirmed write across restart');
      throw new Incomplete('Unconfirmed create retained for review. The runner did not retry or modify a title match.');
    }
    need(!(await page.locator('#dialog[open] [role=alert]').isVisible()), 'The app reported an error while creating the disposable item.');
    const receipt = page.locator('#toast');
    const message = destinations[kind].route === 'mac' ? 'Saved in Apple Calendar for sync to Google' : 'Item created';
    return !(await page.locator('#dialog').isVisible()) && await receipt.isVisible() &&
      await receipt.textContent() === message && await item(kind).count() === 1;
  }, 'The app did not confirm the create.', 60_000);
  const id = await item(kind).getAttribute('data-item-id');
  need(typeof id === 'string' && id.trim(), 'The app did not confirm the original provider ID.');
  const saved = await read(kind, id);
  need(!saved.missing && (allDay ? saved.allDay && saved.day === day :
    Date.parse(saved.start) === time(day, '09:00') && Date.parse(saved.end) === time(day, '09:30')), 'The created item has different source dates.');
  report.disposableItems[kind] = 'created and confirmed by original ID';
  report.providers[kind].itemId = id;
  if (saved.externalId) report.providers[kind].externalId = saved.externalId;
  await check(kind + ' creation in the designated destination');
  return id;
}

async function changeTime(kind, id, date, start, end, edge) {
  await stage((edge ? 'Resize ' : 'Move ') + 'the disposable ' + kind + ' item');
  const current = await read(kind, id);
  need(!current.missing && !current.completed, 'The run-specific item is no longer editable.');
  const eligible = page.locator('#timeline [data-item-id=' + JSON.stringify(id) + ']');
  need(await eligible.count() === 1 && await item(kind, id).count() === 1, 'The drag target is ambiguous.');
  const [hour, minute] = (edge ? end : start).split(':').map(Number);
  await driver.dragTo({ itemId: id, day: date, hour, minute, edge });
  await at(item(kind, id), date, start, end).waitFor({ timeout: 60_000 });
  const saved = await read(kind, id);
  need(!saved.allDay && Date.parse(saved.start) === time(date, start) && Date.parse(saved.end) === time(date, end), 'The source did not confirm the edited times.');
  await check(kind + (edge ? ' resize' : ' move') + ' on the original ID');
  await checkAppReceipt(kind, id);
}

async function verifyTickTick() {
  const id = await createOriginal('ticktick', true);
  await stage('Add non-empty notes and a checklist to the original disposable task through TickTick');
  need((await probe('ticktick', id, 'seed')).sent, 'The original task was unavailable for checklist setup.');
  const seeded = await read('ticktick', id);
  if (!seeded.hasNotes || !seeded.hasChecklist) throw new Incomplete('TickTick did not return the seeded note and checklist with an item ID.');
  need(seeded.allDay && seeded.day === day, 'The checklist setup changed the dates of the disposable task.');
  ticktickDetails = seeded.signature;
  await check('TickTick returned the seeded note and checklist with a checklist ID');
  await refresh(page);
  await changeTime('ticktick', id, day, '10:00', '10:30');
  await changeTime('ticktick', id, day, '10:00', '11:00', 'end');
  await changeTime('ticktick', id, tomorrow, '11:00', '12:00');
  await stage('Complete the disposable TickTick task');
  const since = new Date(Date.now() - 60_000).toISOString().replace('Z', '+0000');
  await item('ticktick', id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Complete task' }).click();
  await item('ticktick', id).waitFor({ state: 'detached', timeout: 60_000 });
  const completed = await read('ticktick', id, since);
  if (completed.missing) throw new Incomplete('TickTick no longer returns this ID. Completion and post-completion fields could not be verified.');
  need(completed.completed === true, 'TickTick did not confirm completed status on the original ID.');
  report.disposableItems.ticktick = 'completed';
  await check('TickTick completion and preserved notes/checklist confirmed by original ID and status 2');
  await restart('ticktick');
  need((await read('ticktick', id, since)).completed && await item('ticktick', id).count() === 0, 'The completed TickTick task did not retain its status across restart.');
  await check('Completed TickTick task and preserved fields verified after restart');
  await checkAppReceipt('ticktick', id);
}

async function verifyReadOnly(id) {
  const policy = settings().locator('.settings-source[data-source-id=' + JSON.stringify(destinations.google.id) + ']')
    .getByRole('checkbox', { name: /^Read-only / });
  async function setPolicy(value) {
    if (!(await settings().isVisible())) await page.locator('#manage-calendars').click();
    await policy.setChecked(value);
    await until(async () => await policy.isEnabled() && await policy.isChecked() === value &&
      await settings().getAttribute('aria-busy') !== 'true', 'The disposable calendar policy did not save.', 60_000);
    await settings().getByRole('button', { name: 'Done' }).click();
  }
  await stage('Check a source move while the disposable Google calendar is locally read-only');
  await page.locator('#manage-calendars').click();
  need(!(await policy.isChecked()), 'The designated Google test calendar became read-only before verification.');
  try {
    await setPolicy(true);
    await item('google', id).click({ button: 'right' });
    need(await page.getByRole('menuitem', { name: 'View details' }).isVisible() &&
      await page.getByRole('menuitem', { name: 'Edit item' }).count() === 0 &&
      await page.getByRole('menuitem', { name: 'Delete from Google' }).count() === 0, 'The read-only menu offered a source change.');
    await page.keyboard.press('Escape');
    const stamp = clock => new Date(time(tomorrow, clock)).toISOString();
    const timing = { fromStart: stamp('13:00'), fromEnd: stamp('14:00'), toStart: stamp('14:30'), toEnd: stamp('15:30') };
    need((await probe('google', id, 'move', timing)).sent, 'The disposable event was unavailable for the independent move.');
    const saved = await read('google', id);
    need(Date.parse(saved.start) === Date.parse(timing.toStart) && Date.parse(saved.end) === Date.parse(timing.toEnd), 'The source did not confirm the external move.');
    await refresh(page);
    const moved = at(item('google', id), tomorrow, '14:30', '15:30');
    await moved.waitFor();
    need(await moved.getAttribute('data-editable') === 'false', 'The externally moved Google event became editable during refresh.');
    report.bmw = 'Exchange unconfigured; read-only fallback observed an external event move via ' + report.providers.google.boundary;
    await check('Read-only Google fallback refreshed the external move on the same disposable event');
  } finally {
    if (await page.getByRole('menu').isVisible()) await page.keyboard.press('Escape');
    await setPolicy(false);
    report.providers.google.readOnlySettingRestored = true;
  }
}

async function verifyGoogle() {
  if (destinations.google.route === 'mac') need((await probe('google', 'permission', 'access')).available, 'The independent EventKit store is unavailable.');
  const id = await createOriginal('google', false);
  await changeTime('google', id, tomorrow, '13:00', '13:30');
  await changeTime('google', id, tomorrow, '13:00', '14:00', 'end');
  await verifyReadOnly(id);
  await stage('Hide the disposable Google event and restart');
  await item('google', id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide in Calendar Hub' }).click();
  await item('google', id).waitFor({ state: 'detached' });
  await restart('google');
  need(await item('google', id).count() === 0, 'A hidden event returned after restarting the app.');
  const hidden = await read('google', id);
  need(!hidden.missing && Date.parse(hidden.end) === time(tomorrow, '15:30'), 'The hidden event changed in the source.');
  await check('Google event still present in the source and hidden after restart');
  await stage('Restore and delete the disposable Google event');
  await button('Hidden items').click();
  const row = page.locator('.review-entry').filter({ has: page.getByText(title.google, { exact: true }) });
  need(await row.count() === 1, 'The run-specific hidden record could not be identified.');
  await row.getByRole('button', { name: 'Restore' }).click();
  await row.waitFor({ state: 'detached' });
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  await item('google', id).waitFor();
  await check('Restored the same disposable Google event');
  need(!(await read('google', id)).missing, 'The event to delete is missing.');
  await item('google', id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete from Google' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete from Google?' });
  need(await confirmation.getByRole('checkbox').count() === 0, 'The disposable event now requires guest or recurrence review.');
  await confirmation.getByRole('button', { name: 'Delete from Google', exact: true }).click();
  await item('google', id).waitFor({ state: 'detached', timeout: 60_000 });
  need((await read('google', id)).missing, 'The source still returns the original event as active.');
  report.disposableItems.google = 'deleted';
  await check('Google deletion confirmed in ' + report.providers.google.boundary + ' by original ID');
  await checkAppReceipt('google', id);
}

async function runProvider(kind) {
  const localGoogle = kind === 'google' && destinations.google.route === 'mac';
  const evidence = report.providers[kind] = { status: 'running', boundary: localGoogle ? 'the local EventKit store' : kind === 'google' ? 'the Google Calendar API' : 'the TickTick Open API' };
  if (localGoogle) evidence.googleCloud = 'unverified';
  report.status = 'running';
  try {
    const now = new Date();
    day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    tomorrow = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
    await stage('Start ' + kind + ' verification');
    await connectProbe(kind);
    await showTestDays();
    if (kind === 'ticktick') await verifyTickTick();
    else await verifyGoogle();
    evidence.status = localGoogle ? 'local_verified' : 'passed';
  } catch (error) {
    evidence.status = error instanceof Incomplete ? 'partial' : 'failed';
    evidence.stage = report.stage;
    evidence.reason = errorText(error);
  } finally {
    await closeProbes();
    await saveReport();
  }
}

async function liveJourneys() {
  const timeout = Number(process.env.CALENDAR_LIVE_SETUP_TIMEOUT_MS ?? 900_000);
  need(Number.isFinite(timeout) && timeout >= 0, 'Use a nonnegative setup timeout in milliseconds.');
  const setupTimeout = Math.min(timeout, 900_000);
  report.archiveSha256 = createHash('sha256').update(await readFile(join(appPath, 'Contents/Resources/app.asar'))).digest('hex');
  const pending = new Set(kinds);
  try {
    page = await driver.launch();
    initialView = await page.evaluate(() => ({ view: localStorage.getItem('view') || 'day', count: localStorage.getItem('next-days') || '3' }));
  } catch (error) {
    if (closedDuringSetup(error)) return recordClosedSetup(pending);
    throw error;
  }
  while (pending.size) {
    let ready;
    try { ready = await nextDestinations(pending, setupTimeout); }
    catch (error) {
      if (closedDuringSetup(error)) return recordClosedSetup(pending);
      throw error;
    }
    if (!Object.keys(ready).length) break;
    Object.assign(destinations, ready);
    for (const kind of Object.keys(ready)) {
      pending.delete(kind);
      await runProvider(kind);
      try {
        const close = page.locator('#dialog[open]').getByRole('button', { name: 'Close', exact: true });
        if (await close.isVisible()) await close.click({ timeout: 2000 });
        if (await page.getByRole('menu').isVisible()) await page.keyboard.press('Escape');
      } catch {
        page = await driver.restart();
      }
    }
  }
  for (const kind of pending) report.providers[kind] = { status: 'not_run', reason: report.setup[kind] };
  if (kinds.some(kind => report.providers[kind].status !== 'not_run')) {
    if (await settings().isVisible()) await settings().getByRole('button', { name: 'Done' }).click();
    if (!(await page.locator('#dialog[open]').isVisible())) {
      await page.locator('[data-view="next"]').click();
      const count = page.getByRole('spinbutton', { name: 'Number of days' });
      await count.fill(initialView.count); await count.press('Tab');
      await page.locator('[data-view=' + JSON.stringify(initialView.view) + ']').click();
      await button('Today').click();
    }
    const statuses = Object.values(report.providers).map(provider => provider.status);
    report.status = statuses.every(status => status === 'passed') ? 'passed' : statuses.includes('failed') ? 'failed' : 'partial';
    await stage('Finished available provider checks');
  } else await saveReport();
}

try {
  await saveReport();
  await liveJourneys();
} catch (error) {
  report.status = 'failed';
  report.error = Object.keys(report.disposableItems).length || error instanceof LiveError ? errorText(error) : 'The live setup did not finish before provider checks started.';
  await saveReport();
} finally {
  await closeProbes();
  await driver.close().catch(() => {});
  if (nativeDirectory) await rm(nativeDirectory, { recursive: true, force: true });
  if (leaveOpen) {
    try { await execute('/usr/bin/open', [appPath]); }
    catch { report.applicationReopen = 'Open the packaged Calendar Hub app to finish setup.'; await saveReport(); }
  }
  console.log('Live desktop verification: ' + report.status + '. See build/verification/live/latest.json.');
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
}
