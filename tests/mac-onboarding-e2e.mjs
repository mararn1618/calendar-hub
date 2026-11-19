import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createItem, DesktopDriver, until } from './desktop-driver.mjs';
import { startMacCalendarFixture } from './fixtures/mac-calendar.mjs';

const work = { id: 'bmw-exchange', name: 'BMW Work', accountName: 'BMW', writable: true };
const google = { id: 'google-personal', name: 'Personal', accountName: 'personal@example.test', calDAV: true, writable: true };
const shared = { id: 'google-shared', name: 'Shared', accountName: 'team@example.test', calDAV: true, writable: false };
const other = { id: 'caldav-other', name: 'Family', accountName: 'Other CalDAV', calDAV: true, writable: true };

const option = calendar => `${calendar.accountName} · ${calendar.name}${calendar.writable ? '' : ' (read-only)'}`;
const manage = page => page.locator('#manage-calendars').click();
const fixtureItem = (page, title) => page.getByRole('button', { name: title, exact: true });

export async function verifyMacOnboarding({ temporary, evidence }) {
  const directory = await mkdtemp(join(temporary, 'mac-google-'));
  const configPath = join(directory, 'test-config.json');
  const calendars = [work];
  const fixture = await startMacCalendarFixture(calendars);
  const driver = new DesktopDriver({ evidenceDirectory: evidence, configPath });
  try {
    await writeFile(configPath, JSON.stringify({ origin: fixture.origin, macFixture: true, googleBrowser: false }));
    let page = await driver.launch();
    const day = await page.locator('.day-column').first().getAttribute('data-date');
    const nextDay = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    fixture.events.set('bmw-meeting', { id: 'bmw-meeting', title: 'BMW planning meeting', providerCalendarId: work.id,
      start: day, end: nextDay, allDay: true, version: '1' });
    let dialog = page.locator('dialog[open]');
    await manage(page);
    await dialog.getByRole('button', { name: 'Connect Google', exact: true }).click();
    const startPicker = dialog.getByRole('button', { name: 'Choose Google calendars on this Mac', exact: true });
    await startPicker.waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Continue with Google', exact: true }).count(), 0);
    assert.equal(await dialog.getByLabel('Client ID', { exact: true }).count(), 0);
    await startPicker.click();
    const internetAccounts = dialog.getByRole('button', { name: 'Open Internet Accounts', exact: true });
    await internetAccounts.waitFor();
    assert.equal(await internetAccounts.isEnabled(), true);
    await dialog.getByText('Add Google in System Settings', { exact: false }).waitFor();
    await driver.screenshot(page, 'mac-google-internet-accounts');

    calendars.push(google, shared, other);
    await dialog.getByRole('button', { name: 'Check again', exact: true }).click();
    const picker = calendar => dialog.getByRole('checkbox', { name: option(calendar), exact: true });
    const choose = dialog.getByRole('button', { name: 'Use selected calendars', exact: true });
    await choose.waitFor();
    assert.equal(await choose.isEnabled(), false);
    for (const calendar of [google, shared, other]) assert.equal(await picker(calendar).isChecked(), false);
    assert.equal(await picker(work).count(), 0);
    await picker(google).check();
    await driver.screenshot(page, 'mac-google-calendar-picker');
    await choose.click();

    const source = name => dialog.getByRole('checkbox', { name, exact: true });
    await source(google.name).waitFor();
    assert.equal(await source(google.name).isChecked(), true);
    assert.equal(await source(shared.name).count(), 0);
    assert.equal(await source(other.name).count(), 0);
    await dialog.getByRole('button', { name: 'Connect Mac calendars', exact: true }).click();
    await dialog.getByRole('button', { name: 'Choose Mac calendars', exact: true }).click();
    await source(work.name).check();
    const done = dialog.getByRole('button', { name: 'Done', exact: true });
    await until(async () => await source(work.name).isChecked() && await done.isEnabled(), 'Mac calendar selection did not save.');
    await done.click();

    const bmw = fixtureItem(page, 'BMW planning meeting');
    assert.equal(await bmw.getAttribute('data-editable'), 'false');
    await bmw.click();
    await page.getByRole('dialog', { name: 'Item details' }).getByText('This item is read-only in Calendar Central.').waitFor();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('#new-item').click();
    const destinations = dialog.locator('#item-calendar option');
    await destinations.first().waitFor({ state: 'attached' });
    assert.deepEqual(await destinations.allTextContents(), [google.name]);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    const title = 'Planning appointment';
    await createItem(page, { title, calendar: google.name, allDay: false, day, hour: 11 });
    await fixtureItem(page, title).waitFor();
    const created = [...fixture.events.values()].find(event => event.title === title);
    assert.equal(created?.providerCalendarId, google.id);
    assert.equal(new Date(created.start).getHours(), 11);
    await fixtureItem(page, title).click();
    await dialog.getByLabel('Start time', { exact: true }).fill('12:00');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await until(async () => !await dialog.count(), 'Google calendar edit did not finish.');
    const updated = fixture.events.get(created.id);
    assert.equal(new Date(updated.start).getHours(), 12);
    assert.equal(Date.parse(updated.end) - Date.parse(updated.start), 30 * 60_000);
    assert.notEqual(updated.version, created.version);

    page = await driver.restart();
    dialog = page.locator('dialog[open]');
    const restored = fixtureItem(page, title);
    await restored.waitFor();
    assert.match(await restored.getAttribute('aria-description'), /12:00/);
    await manage(page);
    await dialog.getByRole('button', { name: 'Choose calendars', exact: true }).click();
    await picker(google).waitFor();
    assert.equal(await picker(google).isChecked(), true);
    assert.equal(await picker(shared).isChecked(), false);
    assert.equal(await picker(other).isChecked(), false);
    await driver.screenshot(page, 'mac-google-selection-after-restart');

    const googleReads = fixture.calls.filter(call => call.action === 'items' && call.route === 'google');
    assert.deepEqual([...new Set(googleReads.map(call => call.calendarId))], [google.id]);
    const writes = fixture.calls.filter(call => ['create', 'update'].includes(call.action));
    assert.deepEqual(writes.map(call => [call.action, call.route, call.calendarId]), [['create', 'google', google.id], ['update', 'google', google.id]]);
    assert.deepEqual(driver.errors, [], 'Unexpected renderer errors during Mac calendar onboarding');
  } catch (error) {
    if (driver.page && !driver.page.isClosed()) await driver.screenshot(driver.page, 'mac-google-onboarding-failure').catch(() => {});
    throw error;
  } finally {
    try { await driver.close(); }
    finally { await fixture.close(); }
  }
}
