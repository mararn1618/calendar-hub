import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addDays } from '../ui/dates.js';
import { DesktopDriver, refresh, until } from './desktop-driver.mjs';
import { createMacCalendarFixture } from './fixtures/mac-calendar.mjs';
import { startProviderServer } from './provider-server.mjs';

const offices = [
  { id: 'office-a', name: 'Project meetings', accountId: 'exchange-a', accountName: 'First office', exchange: true },
  { id: 'office-b', name: 'Client meetings', accountId: 'exchange-b', accountName: 'Second office', exchange: true },
];
const cachedTask = 'Review the launch plan';
const updatedTask = 'Updated launch plan';
const throttleMessage = /TickTick reached its request limit/i;
const button = (area, name) => area.getByRole('button', { name, exact: true });
const dialog = page => page.locator('dialog[open]');
const item = (page, title) => button(page.locator('#timeline'), title);
const openPrivacy = page => button(page, 'Open Calendar Privacy Settings');
const macNotice = page => page.locator('#mac-calendar-access');
const toggle = page => page.locator('#toggle-sidebar');
const tickLimit = page => page.locator('#notices').getByText(throttleMessage);

async function recordPrivacyAction(area, mac) {
  const before = mac.settingsOpened.length;
  await openPrivacy(area).click();
  await until(() => mac.settingsOpened.length > before, 'The Calendar Privacy Settings action did not reach the settings recorder.');
  assert.deepEqual(mac.settingsOpened.slice(before), ['calendarPrivacy']);
}

async function verifyFirstConnection(driver, page, mac) {
  const settings = dialog(page);
  const picker = settings.getByLabel('Apple Calendar account', { exact: true });
  mac.controls.calendarAccess = 'denied';
  await button(page, 'Manage calendars').click();
  assert.equal(await settings.locator('.connection-group').count(), 0);
  await button(settings, 'Connect Exchange').click();
  await openPrivacy(settings).waitFor();
  await settings.getByText(/choose Full Access/i).waitFor();
  assert.equal(await picker.count(), 0);
  assert.deepEqual(mac.settingsOpened, []);
  await driver.screenshot(page, 'calendar-privacy-first-connection');
  await recordPrivacyAction(settings, mac);
  mac.controls.calendarAccess = 'full';
  await button(settings, 'Check access').click();
  await picker.waitFor();
  assert.deepEqual(await picker.locator('option').allTextContents(), ['Choose an account', ...offices.map(office => office.accountName)]);
  await button(settings, 'Back').click();

  mac.controls.calendarAccess = 'denied';
  await button(settings, 'Connect Mac calendars').click();
  await button(settings, 'Choose Mac calendars').click();
  await openPrivacy(settings).waitFor();
  mac.controls.calendarAccess = 'full';
  await button(settings, 'Check access').click();
  const account = settings.getByRole('region', { name: 'Mac calendars', exact: true });
  await account.getByRole('checkbox', { name: offices[0].name, exact: true }).waitFor();
  await button(account, 'Disconnect').click();
  await button(page.getByRole('dialog', { name: 'Disconnect calendar?', exact: true }), 'Disconnect').click();
  await button(settings, 'Connect Exchange').waitFor();
  assert.equal(await settings.locator('.connection-group').count(), 0);
  await button(settings, 'Done').click();
}

async function connectAccounts(driver, page) {
  const settings = dialog(page);
  await button(page, 'Manage calendars').click();
  for (const office of offices) {
    await button(settings, 'Connect Exchange').click();
    await settings.getByLabel('Apple Calendar account', { exact: true }).selectOption(office.accountId);
    await button(settings, 'Connect Exchange account').click();
    const account = settings.getByRole('region', { name: office.accountName, exact: true });
    const selection = account.getByRole('checkbox', { name: office.name, exact: true });
    await selection.check();
    await until(async () => await selection.isChecked() && await button(settings, 'Done').isEnabled(), 'Exchange calendar selection did not save.');
  }
  await button(settings, 'Connect TickTick').click();
  const popup = driver.application.waitForEvent('window');
  await button(settings, 'Continue with TickTick').click();
  await button(await popup, 'Authorize test tasks').click();
  await button(settings, 'Edit lists').waitFor();
  await button(settings, 'Done').click();
  await refresh(page);
}

async function assertSidebar(page, expanded) {
  const sidebar = page.locator('#sidebar');
  const control = toggle(page);
  await sidebar.waitFor({ state: expanded ? 'visible' : 'hidden' });
  assert.equal(await control.getAttribute('aria-expanded'), String(expanded));
  assert.equal(await control.getAttribute('aria-controls'), 'sidebar');
  assert.equal(await control.getAttribute('aria-label'), expanded ? 'Hide sidebar' : 'Show sidebar');
  for (const name of ['Date picker', 'Selected calendars']) {
    assert.equal(await page.getByRole('region', { name, exact: true }).count(), Number(expanded));
  }
}

async function collapseSidebar(driver, page) {
  await assertSidebar(page, true);
  const timeline = page.locator('#timeline');
  const calendarWidth = (await timeline.boundingBox()).width;
  const sidebarWidth = (await page.locator('#sidebar').boundingBox()).width;
  await toggle(page).focus();
  await page.keyboard.press('Space');
  await assertSidebar(page, false);
  assert.equal(await toggle(page).evaluate(node => node === document.activeElement), true);
  assert.ok((await timeline.boundingBox()).width >= calendarWidth + sidebarWidth - 1, 'The timeline did not reclaim the sidebar width.');

  await button(page, 'New item').click();
  await page.getByRole('dialog', { name: 'New item', exact: true }).getByLabel('Title', { exact: true }).waitFor();
  await button(dialog(page), 'Cancel').click();
  await button(page, 'Manage calendars').click();
  await page.getByRole('dialog', { name: 'Calendars', exact: true }).waitFor();
  await button(dialog(page), 'Done').click();
  await driver.screenshot(page, 'sidebar-collapsed');
}

async function verifyDeniedAccess(driver, page, mac, provider) {
  for (const office of offices) await item(page, office.name).waitFor();
  await item(page, cachedTask).waitFor();

  mac.controls.calendarAccess = 'denied';
  provider.controls.tickReadStatus = 429;
  for (const office of offices) {
    Object.assign(mac.events.get(office.id), { title: office.name + ' updated', version: '2' });
  }
  provider.originals.get('review').title = updatedTask;
  await refresh(page);
  await macNotice(page).waitFor();
  await tickLimit(page).waitFor();
  assert.match(await macNotice(page).innerText(), /full (?:calendar )?access/i);
  assert.equal(await openPrivacy(page).count(), 1);
  assert.equal(await button(macNotice(page), 'Check access').isEnabled(), true);
  assert.deepEqual(mac.settingsOpened, ['calendarPrivacy']);
  for (const office of offices) await item(page, office.name).waitFor();
  await item(page, cachedTask).waitFor();
  await driver.screenshot(page, 'calendar-privacy-while-collapsed');

  await button(page, 'Sync details').click();
  const details = page.getByRole('dialog', { name: 'Sync details', exact: true });
  await details.getByText(throttleMessage).waitFor();
  await button(details, 'Done').click();
  await recordPrivacyAction(page, mac);

  const tickTickRequests = provider.controls.requests.length;
  mac.controls.calendarAccess = 'full';
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });
  await macNotice(page).waitFor({ state: 'hidden' });
  assert.equal(await openPrivacy(page).count(), 0);
  await tickLimit(page).waitFor();
  for (const office of offices) await item(page, office.name + ' updated').waitFor();
  await item(page, cachedTask).waitFor();
  await button(page, 'Sync details').click();
  await details.getByText(throttleMessage).waitFor();
  await button(details, 'Done').click();
  assert.equal(provider.controls.requests.length, tickTickRequests, 'Returning from Calendar Privacy Settings retried TickTick.');
}

async function verifyUnrequestedAccess(page, mac, provider, callsAtRestart) {
  const allow = button(macNotice(page), 'Allow Calendar Access');
  const authorizations = () => mac.calls.slice(callsAtRestart).filter(call => call.action === 'authorize').map(call => call.route);
  await allow.waitFor();
  await refresh(page);
  await allow.waitFor();
  assert.deepEqual(authorizations(), [], 'A passive refresh requested Calendar access.');
  assert.equal(await openPrivacy(page).count(), 0);

  let tickTickRequests = provider.controls.requests.length;
  mac.controls.declineCalendarAccess = true;
  await allow.click();
  await openPrivacy(macNotice(page)).waitFor();
  assert.equal(await allow.count(), 0);
  assert.deepEqual(authorizations(), ['mac']);
  assert.equal(provider.controls.requests.length, tickTickRequests, 'Declining Mac calendar access retried TickTick.');

  delete mac.controls.declineCalendarAccess;
  mac.controls.calendarAccess = 'undetermined';
  await refresh(page);
  await allow.waitFor();
  assert.deepEqual(authorizations(), ['mac']);
  tickTickRequests = provider.controls.requests.length;
  await allow.click();
  await macNotice(page).waitFor({ state: 'hidden' });
  await tickLimit(page).waitFor();
  assert.deepEqual(authorizations(), ['mac', 'mac']);
  assert.equal(provider.controls.requests.length, tickTickRequests, 'Allowing Mac calendar access retried TickTick.');
}

export async function verifyMacUsability({ temporary, evidence }) {
  const directory = await mkdtemp(join(temporary, 'mac-usability-'));
  const configPath = join(directory, 'test-config.json');
  const mac = createMacCalendarFixture(offices);
  const provider = await startProviderServer({ macCalendar: mac });
  const driver = new DesktopDriver({ configPath, evidenceDirectory: evidence });
  try {
    await writeFile(configPath, JSON.stringify({ origin: provider.origin, macFixture: true }));
    const { day } = provider;
    const nextDay = addDays(day, 1);
    for (const office of offices) {
      mac.events.set(office.id, { id: office.id, title: office.name, providerCalendarId: office.id, start: day, end: nextDay, allDay: true, version: '1' });
    }

    let page = await driver.launch();
    await driver.application.evaluate(({ shell }) => {
      shell.openExternal = async () => { throw new Error('Unexpected external app launch in the Mac calendar fixture.'); };
    });
    await verifyFirstConnection(driver, page, mac);
    await connectAccounts(driver, page);
    await collapseSidebar(driver, page);
    await verifyDeniedAccess(driver, page, mac, provider);

    mac.controls.calendarAccess = 'undetermined';
    const callsAtRestart = mac.calls.length;
    page = await driver.restart();
    await assertSidebar(page, false);
    await verifyUnrequestedAccess(page, mac, provider, callsAtRestart);

    delete provider.controls.tickReadStatus;
    await refresh(page);
    await item(page, updatedTask).waitFor();
    await button(page, 'Sync details').waitFor({ state: 'hidden' });

    await toggle(page).focus();
    await page.keyboard.press('Enter');
    await assertSidebar(page, true);
    assert.equal(await toggle(page).evaluate(node => node === document.activeElement), true);
    for (const office of offices) {
      await page.locator('#source-list').getByRole('checkbox', { name: office.name, exact: true }).waitFor();
      await item(page, office.name + ' updated').waitFor();
    }
    assert.deepEqual(mac.settingsOpened, ['calendarPrivacy', 'calendarPrivacy']);
    assert.deepEqual(driver.errors, [], 'Unexpected renderer errors during the Mac usability journey');
  } catch (error) {
    if (driver.page && !driver.page.isClosed()) await driver.screenshot(driver.page, 'mac-usability-failure').catch(() => {});
    throw error;
  } finally {
    try { await driver.close(); }
    finally { await provider.close(); }
  }
}
