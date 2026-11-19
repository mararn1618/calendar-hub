import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appPath, DesktopDriver, createItem, refresh, until } from './desktop-driver.mjs';

const output = fileURLToPath(new URL('../build/verification/live/', import.meta.url));
const runId = randomUUID();
const prefix = 'Calendar Central test ' + runId;
const title = { ticktick: prefix + ' task', google: prefix + ' appointment' };
const names = {
  ticktick: process.env.CALENDAR_LIVE_TICKTICK_LIST,
  google: process.env.CALENDAR_LIVE_GOOGLE_CALENDAR,
};
const report = {
  runId, startedAt: new Date().toISOString(), status: 'starting', stage: 'Launch the packaged Mac app',
  build: null, setup: {}, checks: [], disposableItems: {}, bmw: 'unconfigured',
  evidence: 'Packaged Mac app and independent first-party reads by original ID. No personal screenshots.',
};
const driver = new DesktopDriver({ evidenceDirectory: output });
const pendingError = 'A provider write is unconfirmed. Check the run-specific item in the source before any retry.';
let page, reader, sources, ticktickDetails, leaveOpen = false;

class LiveError extends Error {}
function need(condition, message) { if (!condition) throw new LiveError(message); }

async function saveReport() {
  await mkdir(output, { recursive: true, mode: 0o700 });
  report.updatedAt = new Date().toISOString();
  const contents = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(output, runId + '.json'), contents, { mode: 0o600 });
  const temporary = join(output, runId + '.tmp');
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, join(output, 'latest.json'));
}
async function check(name) {
  report.checks.push(name);
  await saveReport();
}
async function stage(name) {
  report.stage = name;
  await saveReport();
}

function inspectSetup({ app }, requested) {
  if (!app.isPackaged || process.argv.some(arg => arg.startsWith('--calendar-test-config='))) return { invalid: true };
  const fs = process.getBuiltinModule('fs');
  const file = process.getBuiltinModule('path').join(app.getPath('userData'), 'calendar.json');
  const { connections, sources } = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { connections: [], sources: [] };
  const setup = {}, selected = {};
  for (const kind of ['ticktick', 'google']) {
    if (!connections.some(c => c.provider === kind)) { setup[kind] = 'unconfigured'; continue; }
    const eligible = sources.filter(s => s.provider === kind && s.selected && s.writable && !s.readOnly &&
      !(kind === 'ticktick' && (s.remote?.inbox || /^inbox(?:\d+)?$/.test(s.remoteId))));
    const matches = requested[kind] ? eligible.filter(s => [s.name, s.id, s.remoteId].includes(requested[kind])) : eligible;
    setup[kind] = matches.length === 1 ? 'ready' : matches.length ? 'multiple eligible selections' : 'select a writable destination';
    if (matches.length === 1) selected[kind] = matches[0].id;
  }
  return { setup, selected, build: app.getVersion() };
}

async function selectDestinations() {
  const configuredWait = Number(process.env.CALENDAR_LIVE_SETUP_TIMEOUT_MS ?? 900_000);
  need(Number.isFinite(configuredWait) && configuredWait >= 0, 'Use a nonnegative setup timeout in milliseconds.');
  const deadline = Date.now() + Math.min(configuredWait, 900_000);
  let opened = false;
  do {
    const info = await driver.application.evaluate(inspectSetup, names);
    need(!info.invalid, 'Use the packaged app with its own production profile.');
    report.build = info.build;
    if (info.selected.ticktick && info.selected.google) {
      report.setup = info.setup;
      const settings = page.getByRole('dialog', { name: 'Calendars', exact: true });
      if (await settings.isVisible()) await settings.getByRole('button', { name: 'Done', exact: true }).click();
      return info.selected;
    }
    if (!opened) {
      const settings = page.getByRole('dialog', { name: 'Calendars', exact: true });
      if (!(await settings.isVisible())) await page.locator('#manage-calendars').click();
      opened = true;
    }
    const signingIn = await page.getByRole('dialog', { name: /^Connect (Google|TickTick)$/ }).isVisible();
    const missing = Object.values(info.setup).filter(s => s === 'unconfigured').length;
    const status = signingIn || missing === 1 ? 'pending_login' : missing === 2 ? 'unconfigured' : 'pending_selection';
    if (JSON.stringify(info.setup) !== JSON.stringify(report.setup) || report.status !== status) {
      report.status = status;
      report.setup = info.setup;
      await stage('Waiting in Calendar Central for account setup and destination selection');
      console.log('Live setup: ' + status + '. See build/verification/live/latest.json.');
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(2000, deadline - Date.now()));
  } while (true);
  leaveOpen = true;
  report.setupTimedOut = true;
  await saveReport();
  return null;
}

function firstPartyReader({ app, safeStorage }, { selected, titles }) {
  if (!app.isPackaged || process.argv.some(arg => arg.startsWith('--calendar-test-config='))) throw new Error('Wrong profile.');
  const path = process.getBuiltinModule('path').join(app.getPath('userData'), 'calendar.json');
  const fs = process.getBuiltinModule('fs');
  const { sources, connections } = JSON.parse(fs.readFileSync(path, 'utf8'));
  const grants = {};
  for (const kind of ['ticktick', 'google']) {
    const source = sources.find(row => row.id === selected[kind] && row.provider === kind);
    const account = connections.find(row => row.id === source?.connectionId && row.provider === kind);
    if (!account?.secret || !source.selected || !source.writable) throw new Error('Selected account unavailable.');
    const secret = JSON.parse(safeStorage.decryptString(Buffer.from(account.secret, 'base64')));
    grants[kind] = { list: source.remoteId, secret };
  }
  const options = () => ({ redirect: 'error', signal: AbortSignal.timeout(20_000) });
  return async ({ kind, id }) => {
    if (!Object.hasOwn(grants, kind) || !id || id === '.' || id === '..') return { error: 'invalid target' };
    const { list, secret } = grants[kind];
    let token = secret.token;
    if (kind === 'google') {
      if (!(secret.accessToken && secret.expiresAt > Date.now() + 30_000)) {
        const body = new URLSearchParams({ client_id: secret.clientId, refresh_token: secret.refreshToken, grant_type: 'refresh_token' });
        if (secret.clientSecret) body.set('client_secret', secret.clientSecret);
        const fresh = await fetch('https://oauth2.googleapis.com/token', { ...options(), method: 'POST', body });
        if (!fresh.ok) return { error: 'Google authorization expired' };
        const renewed = await fresh.json();
        secret.accessToken = renewed.access_token;
        secret.expiresAt = Date.now() + 1000 * renewed.expires_in;
      }
      token = secret.accessToken;
    }
    if (!token) return { error: 'missing authorization' };
    const listPath = encodeURIComponent(list), itemPath = encodeURIComponent(id);
    const url = kind === 'ticktick'
      ? 'https://api.ticktick.com/open/v1/project/' + listPath + '/task/' + itemPath
      : 'https://www.googleapis.com/calendar/v3/calendars/' + listPath + '/events/' + itemPath +
        '?fields=id,summary,status,start,end,attendees(responseStatus),attendeesOmitted,recurrence,recurringEventId';
    const response = await fetch(url, { ...options(), headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if ([404, 410].includes(response.status)) return { missing: true };
    if (!response.ok) return { error: 'first-party read returned HTTP ' + response.status };
    const item = await response.json();
    if (item.id !== id) return { error: 'provider returned another ID' };
    if (kind === 'google' && item.status === 'cancelled') return { missing: true };
    if ((kind === 'google' ? item.summary : item.title) !== titles[kind]) return { error: 'run-specific title changed' };
    if (kind === 'ticktick') {
      if (item.projectId !== list || item.repeatFlag) return { error: 'task list or recurrence changed' };
      const start = item.startDate || item.dueDate, end = item.dueDate || start;
      let day;
      if (item.isAllDay && start) {
        day = /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : new Intl.DateTimeFormat('sv-SE', {
          timeZone: item.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
          year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(start));
      }
      const checklist = item.items || [];
      const details = JSON.stringify([item.content || '', item.desc || '', checklist], (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
      const signature = process.getBuiltinModule('crypto').createHash('sha256').update(details).digest('hex');
      return { allDay: item.isAllDay, day, start, end, completed: item.status === 2,
        signature, hasNotes: !!(item.content || item.desc), hasChecklist: checklist.length > 0 };
    }
    if (item.attendees?.length || item.attendeesOmitted || item.recurrence || item.recurringEventId) {
      return { error: 'event acquired guests or recurrence' };
    }
    return { allDay: !!item.start?.date, start: item.start?.dateTime, end: item.end?.dateTime };
  };
}

async function connectReader() {
  reader = await driver.application.evaluateHandle(firstPartyReader, { selected: sources, titles: title });
}

async function read(kind, id) {
  const row = await reader.evaluate((probe, input) => probe(input), { kind, id });
  need(!row.error, 'Independent read failed: ' + row.error);
  if (kind === 'ticktick' && !row.missing && !row.completed) {
    if (ticktickDetails === undefined) {
      ticktickDetails = row.signature;
      report.ticktickBaseline = { hasNotes: row.hasNotes, hasChecklist: row.hasChecklist };
    } else need(ticktickDetails === row.signature, 'Notes or checklist changed while editing the disposable task.');
  }
  return row;
}

const date = new Date();
const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const tomorrow = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
const time = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00');
const button = name => page.getByRole('button', { name, exact: true });
const item = (kind, id) => button(title[kind]).and(page.locator('[data-source-id=' + JSON.stringify(sources[kind]) + ']' +
  (id ? '[data-item-id=' + JSON.stringify(id) + ']' : '')));

async function createOriginal(kind, allDay) {
  await stage('Create a disposable ' + kind + ' item');
  await createItem(page, { title: title[kind], calendarValue: sources[kind], allDay, day, hour: 9 });
  await until(async () => {
    need(!(await page.getByRole('dialog', { name: 'Review unconfirmed writes' }).isVisible()), pendingError);
    need(!(await page.locator('#dialog[open] [role=alert]').isVisible()), 'The app reported an error while creating the disposable item.');
    const receipt = page.locator('#toast');
    return !(await page.locator('#dialog').isVisible()) && await receipt.isVisible() &&
      await receipt.textContent() === 'Item created' && await item(kind).count() === 1;
  }, 'The app did not confirm the create.', 60_000);
  const id = await item(kind).getAttribute('data-item-id');
  need(typeof id === 'string' && id.trim(), 'The app did not confirm the original provider ID.');
  const saved = await read(kind, id);
  need(!saved.missing && (allDay ? saved.allDay && saved.day === day :
    Date.parse(saved.start) === time(day, '09:00') && Date.parse(saved.end) === time(day, '09:30')), 'The created item has different source dates.');
  report.disposableItems[kind] = 'created and confirmed by original ID';
  await check(kind + ' creation in the selected destination');
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
  const updated = item(kind, id).and(page.locator('[data-date="' + date + '"][aria-description*="' + start + '"][aria-description*="' + end + '"]'));
  await updated.waitFor({ timeout: 60_000 });
  const saved = await read(kind, id);
  need(!saved.allDay && Date.parse(saved.start) === time(date, start) && Date.parse(saved.end) === time(date, end),
    'The first-party read did not confirm the edited times.');
  await check(kind + (edge ? ' resize' : ' move') + ' on the original ID');
}

async function showTestDays() {
  await button('Today').click();
  await button('Next X Days').click();
  const count = page.getByRole('spinbutton', { name: 'Number of days' });
  if (Number(await count.inputValue()) < 2) { await count.fill('2'); await count.press('Tab'); }
  await page.locator('.day-column[data-date="' + tomorrow + '"]').waitFor();
}

async function verifyReadOnly(id) {
  const settings = page.getByRole('dialog', { name: 'Calendars', exact: true });
  const policy = settings.locator('.settings-source[data-source-id=' + JSON.stringify(sources.google) + ']')
    .getByRole('checkbox', { name: /^Read-only / });
  async function setPolicy(value) {
    if (!(await settings.isVisible())) await page.locator('#manage-calendars').click();
    await policy.setChecked(value);
    await until(async () => await policy.isEnabled() && await policy.isChecked() === value &&
      await settings.getAttribute('aria-busy') !== 'true', 'The read-only setting did not save.', 60_000);
    await settings.getByRole('button', { name: 'Done' }).click();
  }
  await stage('Check the local read-only setting on the disposable Google event');
  await page.locator('#manage-calendars').click();
  need(!(await policy.isChecked()), 'The selected Google calendar became read-only.');
  try {
    await setPolicy(true);
    await item('google', id).click({ button: 'right' });
    need(await page.getByRole('menuitem', { name: 'View details' }).isVisible() &&
      await page.getByRole('menuitem', { name: 'Edit item' }).count() === 0 &&
      await page.getByRole('menuitem', { name: 'Delete from Google' }).count() === 0, 'The read-only menu offered a source change.');
    await page.keyboard.press('Escape');
  } finally {
    await setPolicy(false);
  }
  const source = await read('google', id);
  need(!source.missing && Date.parse(source.start) === time(tomorrow, '13:00'), 'Read-only policy changed the remote event.');
  await check('Local read-only policy tested on the disposable Google event');
}

async function liveJourneys() {
  page = await driver.launch();
  sources = await selectDestinations();
  if (!sources) return;
  report.status = 'running';
  await connectReader();
  await showTestDays();
  const taskId = await createOriginal('ticktick', true);
  await changeTime('ticktick', taskId, day, '10:00', '10:30');
  await changeTime('ticktick', taskId, day, '10:00', '11:00', 'end');
  await changeTime('ticktick', taskId, tomorrow, '11:00', '12:00');
  await stage('Complete the disposable TickTick task');
  await item('ticktick', taskId).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Complete task' }).click();
  await item('ticktick', taskId).waitFor({ state: 'detached', timeout: 60_000 });
  need((await read('ticktick', taskId)).completed === true, 'TickTick did not confirm completed status on the original ID.');
  report.disposableItems.ticktick = 'completed';
  await check('TickTick completion confirmed by original ID and status 2');

  const eventId = await createOriginal('google', false);
  await changeTime('google', eventId, tomorrow, '13:00', '13:30');
  await changeTime('google', eventId, tomorrow, '13:00', '14:00', 'end');
  await verifyReadOnly(eventId);
  await stage('Hide the disposable Google event and restart');
  await item('google', eventId).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide in Calendar Central' }).click();
  await item('google', eventId).waitFor({ state: 'detached' });
  await reader.dispose();
  page = await driver.restart();
  await connectReader();
  await showTestDays();
  await refresh(page);
  need((await read('ticktick', taskId)).completed && await item('ticktick', taskId).count() === 0,
    'The completed TickTick task did not retain its status across the restart.');
  await check('Completed TickTick task retained its original status after restart');
  need(await item('google', eventId).count() === 0, 'A hidden event returned after restarting the app.');
  const hidden = await read('google', eventId);
  need(!hidden.missing && Date.parse(hidden.end) === time(tomorrow, '14:00'), 'The hidden event changed at Google.');
  await check('Google event still present at the source and hidden after restart');
  await stage('Restore and delete the disposable Google event');
  await button('Hidden items').click();
  const row = page.locator('.review-entry').filter({ has: page.getByText(title.google, { exact: true }) });
  need(await row.count() === 1, 'The run-specific hidden record could not be identified.');
  await row.getByRole('button', { name: 'Restore' }).click();
  await row.waitFor({ state: 'detached' });
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  await item('google', eventId).waitFor();
  await check('Restored the same disposable Google event');
  need(!(await read('google', eventId)).missing, 'The event to delete is missing.');
  await item('google', eventId).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete from Google' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete from Google?' });
  need(await confirmation.getByRole('checkbox').count() === 0, 'The disposable event now requires guest or recurrence review.');
  await confirmation.getByRole('button', { name: 'Delete from Google', exact: true }).click();
  await item('google', eventId).waitFor({ state: 'detached', timeout: 60_000 });
  need((await read('google', eventId)).missing, 'Google still returns the original event as active.');
  report.disposableItems.google = 'deleted';
  await check('Google deletion confirmed by first-party lookup of the original ID');
  await button('Day').click();
  await button('Today').click();
  report.status = 'passed';
  await stage('Complete');
}

try {
  await saveReport();
  await liveJourneys();
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof LiveError ? error.message : 'The current step did not finish. Check Calendar Central and the run-specific disposable items.';
  await saveReport();
} finally {
  await reader?.dispose().catch(() => {});
  await driver.close().catch(() => {});
  if (leaveOpen) {
    try { await promisify(execFile)('/usr/bin/open', [appPath]); }
    catch { report.applicationReopen = 'Open the packaged Calendar Central app to finish setup.'; await saveReport(); }
  }
  console.log('Live desktop verification: ' + report.status + '. See build/verification/live/latest.json.');
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
}
