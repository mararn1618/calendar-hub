import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopDriver, until } from './desktop-driver.mjs';
import { drawTimedAppointment } from './drag-create-journeys.mjs';
import { startMacCalendarFixture } from './fixtures/mac-calendar.mjs';
import { chooseCalendarColor, colorControl, displayedColor } from './calendar-color-journeys.mjs';

const work = { id: 'bmw-exchange', name: 'Meetings', accountId: 'exchange-a', accountName: 'Office', exchange: true, writable: true };
const client = { ...work, id: 'client-exchange', accountId: 'exchange-b' };
const google = { id: 'google-personal', name: 'Appointments', accountId: 'google-a', accountName: 'Google', calDAV: true, writable: true };
const shared = { ...google, id: 'google-shared', name: 'Shared', writable: false };
const team = { ...google, id: 'google-team', accountId: 'google-b' };
const local = { id: 'local', name: 'On My Mac', accountId: 'local', accountName: 'On My Mac', writable: true };
const button = (area, name) => area.getByRole('button', { name, exact: true });
const checkbox = (area, name) => area.getByRole('checkbox', { name, exact: true });

export async function verifyMacOnboarding({ temporary, evidence }) {
  const directory = await mkdtemp(join(temporary, 'mac-accounts-'));
  const configPath = join(directory, 'test-config.json');
  const calendars = [work, client, local];
  const fixture = await startMacCalendarFixture(calendars);
  const driver = new DesktopDriver({ evidenceDirectory: evidence, configPath });
  try {
    await writeFile(configPath, JSON.stringify({ origin: fixture.origin, macFixture: true, googleBrowser: false }));
    let page = await driver.launch();
    const day = await page.locator('.day-column').first().getAttribute('data-date');
    const nextDay = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    let dialog = page.locator('dialog[open]');
    const manage = () => page.locator('#manage-calendars').click();
    const closeSettings = () => button(dialog, 'Done').click();
    const account = name => dialog.getByRole('region', { name, exact: true });
    const accountPicker = () => dialog.getByLabel('Apple Calendar account', { exact: true });
    const nameField = () => dialog.getByLabel('Account name (optional)', { exact: true });
    const item = title => button(page.locator('#timeline'), title);
    async function openGoogle() {
      await button(dialog, 'Connect Google Calendar').click();
      assert.equal(await button(dialog, 'Continue with Google').count(), 0);
      assert.equal(await dialog.getByLabel('Client ID', { exact: true }).count(), 0);
      await button(dialog, 'Choose Google calendars on this Mac').click();
    }
    async function addExchange(source, name) {
      await button(dialog, 'Connect Exchange').click();
      await accountPicker().selectOption(source.accountId);
      await nameField().fill(name);
      await button(dialog, 'Connect Exchange account').click();
      const sourceToggle = checkbox(account(name), source.name);
      await sourceToggle.check();
      await until(async () => await button(dialog, 'Done').isEnabled() && await sourceToggle.isChecked(), 'Exchange selection did not save.');
    }
    for (const [calendar, title] of [[work, 'BMW planning meeting'], [client, 'Client planning meeting']]) {
      fixture.events.set(calendar.id, { id: calendar.id, title, providerCalendarId: calendar.id, start: day, end: nextDay, allDay: true, version: '1' });
    }
    await manage();
    await openGoogle();
    await dialog.getByText('Add Google in System Settings', { exact: false }).waitFor();
    assert.equal(await button(dialog, 'Open Internet Accounts').isEnabled(), true);
    await driver.screenshot(page, 'mac-google-internet-accounts');

    calendars.push(google, shared, team);
    await button(dialog, 'Check again').click();
    await accountPicker().waitFor();
    assert.equal(await button(dialog, 'Use selected calendars').isEnabled(), false);
    const accountNames = await accountPicker().locator('option').allTextContents();
    assert.deepEqual(accountNames, ['Choose an account', 'Google (1)', 'Google (2)']);
    await accountPicker().selectOption(google.accountId);
    await checkbox(dialog, 'Shared (read-only)').check();
    await accountPicker().selectOption(team.accountId);
    assert.equal(await checkbox(dialog, 'Shared (read-only)').count(), 0);
    assert.equal(await button(dialog, 'Use selected calendars').isEnabled(), false);
    await accountPicker().selectOption(google.accountId);
    assert.equal(await checkbox(dialog, 'Shared (read-only)').isChecked(), false);
    await checkbox(dialog, google.name).check();
    await nameField().fill('Personal Google');
    await driver.screenshot(page, 'mac-google-calendar-picker');
    await button(dialog, 'Use selected calendars').click();
    await account('Personal Google').waitFor();
    await openGoogle();
    assert.equal(await accountPicker().locator('option[value="google-a"]').isDisabled(), true);
    assert.equal(await accountPicker().inputValue(), '');
    assert.equal(await button(dialog, 'Use selected calendars').isEnabled(), false);
    await accountPicker().selectOption(team.accountId);
    await checkbox(dialog, team.name).check();
    await nameField().fill('Team Google');
    await button(dialog, 'Use selected calendars').click();
    await account('Team Google').waitFor();
    await addExchange(work, 'BMW');
    await addExchange(client, 'Client');
    await button(account('Client'), 'Rename').click();
    await dialog.getByLabel('Account name', { exact: true }).fill('Client Exchange');
    await button(dialog, 'Save').click();
    await account('Client Exchange').waitFor();

    await button(dialog, 'Connect Mac calendars').click();
    await button(dialog, 'Choose Mac calendars').click();
    await checkbox(account('Mac calendars'), local.name).waitFor();
    for (const label of ['Meetings · Office (1)', 'Meetings · Office (2)']) {
      assert.equal(await checkbox(account('Mac calendars'), label).count(), 1);
    }
    for (const name of ['BMW', 'Client Exchange']) assert.equal(await checkbox(account(name), 'Meetings').isChecked(), true);
    await driver.screenshot(page, 'native-multiple-accounts');
    await closeSettings();
    await chooseCalendarColor(page, 'Meetings', '#ff6123', 'BMW');
    await chooseCalendarColor(page, 'Appointments', '#5522cc', 'Team Google');
    assert.notEqual(await displayedColor(colorControl(page, 'Appointments', 'Personal Google')), '#5522cc');
    assert.notEqual(await displayedColor(colorControl(page, 'Meetings', 'Client Exchange')), '#ff6123');
    for (const [title, accountName] of [['BMW planning meeting', 'BMW'], ['Client planning meeting', 'Client Exchange']]) {
      const meeting = item(title);
      await meeting.waitFor();
      assert.equal(await meeting.getAttribute('data-editable'), 'false');
      await meeting.click();
      await dialog.getByText(accountName + ' · Meetings', { exact: true }).waitFor();
      assert.equal(await displayedColor(dialog.locator('.calendar-context')), await displayedColor(meeting));
      await dialog.getByText('This item is read-only in Calendar Hub.', { exact: true }).waitFor();
      await button(dialog, 'Done').click();
    }

    const title = 'Planning appointment';
    const appointment = await drawTimedAppointment(page, day, '11:00', '11:30');
    const destination = appointment.getByLabel('Calendar', { exact: true });
    const groups = await destination.locator('optgroup').evaluateAll(nodes => nodes.map(node => [node.label, node.children[0].textContent]));
    assert.deepEqual(groups, [['Google Calendar · Personal Google', google.name], ['Google Calendar · Team Google', team.name]]);
    const teamDestination = await destination.locator('optgroup[label="Google Calendar · Team Google"] option').getAttribute('value');
    await destination.selectOption(teamDestination);
    await appointment.getByLabel('Title', { exact: true }).fill(title);
    await driver.screenshot(page, 'mac-google-drawn-appointment');
    await button(appointment, 'Save').click();
    await item(title).waitFor();
    const created = [...fixture.events.values()].find(event => event.title === title);
    assert.equal(created?.providerCalendarId, team.id);
    assert.equal(Date.parse(created.start), Date.parse(day + 'T11:00:00'));
    assert.equal(Date.parse(created.end), Date.parse(day + 'T11:30:00'));
    await item(title).click();
    await dialog.getByLabel('Start time', { exact: true }).fill('12:00');
    await button(dialog, 'Save').click();
    await until(async () => !await dialog.count(), 'Google calendar edit did not finish.');
    const updated = fixture.events.get(created.id);
    assert.equal(new Date(updated.start).getHours(), 12);
    assert.equal(Date.parse(updated.end) - Date.parse(updated.start), 30 * 60_000);
    assert.notEqual(updated.version, created.version);

    page = await driver.restart();
    dialog = page.locator('dialog[open]');
    await item(title).waitFor();
    assert.match(await item(title).getAttribute('aria-description'), /12:00.*Team Google/);
    assert.equal(await displayedColor(item(title)), '#5522cc');
    assert.equal(await displayedColor(item('BMW planning meeting')), '#ff6123');
    const nativeReminders = [
      { id: 'work-alert', title: 'Read-only meeting reminder', calendar: work, connection: 'BMW' },
      { id: 'personal-alert', title: 'Personal appointment reminder', calendar: google, connection: 'Personal Google' },
    ];
    for (const entry of nativeReminders) {
      const start = new Date(nextDay + 'T09:00').toISOString();
      fixture.events.set(entry.id, { id: entry.id, title: entry.title, start, end: new Date(nextDay + 'T09:30').toISOString(),
        allDay: false, version: '1', providerCalendarId: entry.calendar.id });
      const sidebarAccount = page.locator('#source-list').getByRole('group', { name: entry.connection, exact: true });
      await button(sidebarAccount, 'Notifications for ' + entry.calendar.name).click();
      await until(() => [...fixture.notifications.pending.values()].some(reminder => reminder.title === entry.title &&
        Date.parse(reminder.fireAt) === Date.parse(start) - 10 * 60_000), 'The Mac calendar reminder was not scheduled.');
    }
    await manage();
    await button(account('Personal Google'), 'Choose calendars').click();
    assert.equal(await accountPicker().inputValue(), google.accountId);
    assert.equal(await accountPicker().isDisabled(), true);
    assert.equal(await checkbox(dialog, google.name).isChecked(), true);
    await checkbox(dialog, 'Shared (read-only)').check();
    await button(dialog, 'Save calendars').click();
    await checkbox(account('Personal Google'), shared.name).waitFor();

    calendars.splice(calendars.indexOf(shared), 1);
    await button(account('Personal Google'), 'Choose calendars').click();
    const unavailable = checkbox(dialog, 'Shared (temporarily unavailable)');
    assert.equal(await unavailable.isChecked(), true);
    assert.equal(await unavailable.isDisabled(), true);
    await checkbox(dialog, google.name).uncheck();
    calendars.push(shared);
    await button(dialog, 'Save calendars').click();
    await checkbox(account('Personal Google'), shared.name).waitFor();
    assert.equal(await checkbox(account('Personal Google'), google.name).count(), 0);

    calendars.splice(calendars.indexOf(shared), 1);
    calendars.splice(calendars.indexOf(google), 1);
    await button(account('Personal Google'), 'Choose calendars').click();
    assert.equal(await unavailable.isChecked(), true);
    assert.equal(await unavailable.isDisabled(), true);
    assert.equal(await accountPicker().count(), 0);
    await button(dialog, 'Back').click();
    calendars.push(google, shared);

    await button(account('Team Google'), 'Choose calendars').click();
    assert.equal(await accountPicker().inputValue(), team.accountId);
    assert.equal(await checkbox(dialog, team.name).isChecked(), true);
    assert.equal(await checkbox(dialog, 'Shared (read-only)').count(), 0);
    await driver.screenshot(page, 'mac-google-selection-after-restart');
    await button(dialog, 'Back').click();
    for (const name of ['Personal Google', 'Client Exchange']) {
      await button(account(name), 'Disconnect').click();
      await button(dialog, 'Disconnect').click();
      await account(name).waitFor({ state: 'detached' });
      await account('Team Google').waitFor();
    }
    await closeSettings();
    await item(title).waitFor();
    await item('BMW planning meeting').waitFor();
    assert.equal(await item('Client planning meeting').count(), 0);
    const reads = fixture.calls.filter(call => call.action === 'items' && ['google', 'exchange'].includes(call.route));
    for (const call of reads) assert.equal(call.accountId, calendars.find(row => row.id === call.calendarId)?.accountId);
    const writes = fixture.calls.filter(call => ['create', 'update'].includes(call.action));
    assert.deepEqual(writes.map(call => [call.action, call.route, call.accountId, call.calendarId]), [
      ['create', 'google', team.accountId, team.id], ['update', 'google', team.accountId, team.id]
    ]);
    assert.deepEqual(driver.errors, [], 'Unexpected renderer errors during Mac account onboarding');
  } catch (error) {
    if (driver.page && !driver.page.isClosed()) await driver.screenshot(driver.page, 'mac-account-onboarding-failure').catch(() => {});
    throw error;
  } finally {
    try { await driver.close(); }
    finally { await fixture.close(); }
  }
}
