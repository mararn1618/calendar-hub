import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addDays } from '../ui/dates.js';
import { DesktopDriver, refresh, until } from './desktop-driver.mjs';
import { createMacCalendarFixture } from './fixtures/mac-calendar.mjs';
import { startProviderServer } from './provider-server.mjs';

export async function verifyExchangeAllDayHiding({ temporary, evidence }) {
  const directory = await mkdtemp(join(temporary, 'exchange-hide-'));
  const configPath = join(directory, 'test-config.json');
  const work = { id: 'work', name: 'Work', accountId: 'office', accountName: 'Office', exchange: true, writable: true };
  const holidays = { ...work, id: 'holidays', name: 'Holidays' };
  const mac = createMacCalendarFixture([work, holidays]);
  const provider = await startProviderServer({ macCalendar: mac });
  const { day } = provider;
  const next = addDays(day, 3), end = addDays(day, 4);
  const series = { title: 'Office days', allDay: true, recurring: true, version: '1' };
  const entry = { ...series, id: 'series|' + day, visibilityId: 'uid:c2VyaWVz|' + day, start: day, end: next, providerCalendarId: work.id };
  const later = { ...entry, id: 'series|' + next, visibilityId: 'uid:c2VyaWVz|' + next, start: next, end };
  mac.events.set('work-first', entry);
  mac.events.set('work-next', later);
  mac.events.set('holidays-first', { ...entry, providerCalendarId: holidays.id, end: addDays(day, 1) });
  const originals = structuredClone(mac.events);
  const driver = new DesktopDriver({ evidenceDirectory: evidence, configPath });
  try {
    await writeFile(configPath, JSON.stringify({ origin: provider.origin, macFixture: true }));
    let page = await driver.launch();
    provider.accounts[0].tickToken = 'fixture-local-visibility';
    const [workId, holidayId] = await page.evaluate(async ({ day, end, token }) => {
      await window.calendar.connect({ provider: 'exchange', accountId: 'office', route: 'mac', name: 'Office' });
      await window.calendar.connect({ provider: 'ticktick', route: 'token', token });
      const cached = await window.calendar.state({ start: day, end, cachedOnly: true });
      const sources = cached.sources.filter(source => source.provider === 'exchange');
      for (const source of sources) await window.calendar.setSource({ sourceId: source.id, selected: true });
      return ['Work', 'Holidays'].map(name => sources.find(source => source.name === name).id);
    }, { day, end, token: provider.accounts[0].tickToken });
    await page.locator('[data-view="next"]').click();
    await page.getByLabel('Number of days').fill('4');
    await refresh(page);
    const cards = (sourceId, itemId) => page.locator('.all-day-row .calendar-item[data-source-id=' +
      JSON.stringify(sourceId) + '][data-item-id=' + JSON.stringify(itemId) + ']');
    let localId = entry.id;
    const selected = () => cards(workId, localId);
    const verifyOthers = async () => {
      assert.equal(await cards(workId, later.id).count(), 1, 'The next occurrence must remain visible.');
      assert.equal(await cards(holidayId, entry.id).count(), 1, 'The identically named event on Holidays must remain visible.');
    };
    async function hide() {
      assert.equal(await selected().count(), 3);
      const middle = selected().nth(1);
      assert.equal(await middle.getAttribute('data-editable'), 'false');
      await middle.click({ button: 'right' });
      const menu = page.getByRole('menu', { name: 'Item actions' });
      assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['View details', 'Hide in Calendar Hub']);
      await menu.getByRole('menuitem', { name: 'Hide in Calendar Hub' }).click();
    }
    async function restore() {
      await page.getByRole('button', { name: 'Hidden items', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Hidden items' });
      const row = dialog.locator('.review-entry');
      assert.equal(await row.count(), 1);
      await row.getByText(entry.title, { exact: true }).waitFor();
      await row.getByText('Office · Work', { exact: true }).waitFor();
      await row.getByRole('button', { name: 'Restore' }).click();
      await row.waitFor({ state: 'detached' });
      await dialog.getByRole('button', { name: 'Done' }).click();
      assert.equal(await selected().count(), 3);
    }

    mac.controls.calendarAccess = 'denied';
    provider.controls.blockTickReads(5);
    await refresh(page);
    const health = await page.evaluate(async range => (await window.calendar.state({ ...range, cachedOnly: true })).health, { start: day, end });
    assert(health.some(row => row.sourceId === workId && row.state === 'stale'));
    assert(health.some(row => row.state === 'stale' && /request limit/i.test(row.message)));
    await verifyOthers();
    const requestCounts = () => [mac.calls.length, provider.controls.requests.length];
    const beforeHide = requestCounts();
    await hide();
    await until(async () => await selected().count() === 0, 'The stale Exchange entry remained visible after Hide.');
    await verifyOthers();
    await restore();
    assert.deepEqual(requestCounts(), beforeHide, 'Local visibility changes should not contact either provider.');

    const release = Promise.withResolvers();
    let waiting = false;
    mac.controls.beforeRead = async call => {
      if (call.action !== 'sources') return;
      delete mac.controls.beforeRead;
      waiting = true;
      await release.promise;
    };
    try {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await until(() => waiting, 'The provider refresh did not reach Exchange.');
      await hide();
      await until(async () => await selected().count() === 0, 'The Exchange entry is still visible while the provider refresh waits.', 1500);
      await verifyOthers();
      await driver.screenshot(page, 'exchange-all-day-hidden-during-refresh');
    } finally {
      release.resolve();
    }
    await until(async () => await page.locator('#refresh').getAttribute('aria-busy') === 'false', 'Provider refresh did not settle.');
    assert.equal(await selected().count(), 0);
    mac.controls.calendarAccess = 'granted';
    assert.deepEqual(mac.events, originals);
    localId = 'resynced-series|' + day;
    const resynced = { ...entry, id: localId };
    mac.events.set('work-first', resynced);
    originals.set('work-first', structuredClone(resynced));
    await refresh(page);
    assert.equal(await selected().count(), 0, 'Exchange returned a new local ID for the hidden occurrence.');
    mac.controls.calendarAccess = 'denied';
    page = await driver.restart();
    assert.equal(await selected().count(), 0);
    await verifyOthers();
    const beforeRestore = requestCounts();
    await restore();
    assert.deepEqual(requestCounts(), beforeRestore, 'Restoring after restart should use the saved entries.');
    await driver.screenshot(page, 'exchange-all-day-restored-offline');
    assert.deepEqual(mac.events, originals);
    assert.equal(mac.calls.filter(call => ['create', 'update', 'remove'].includes(call.action)).length, 0);
    const writes = provider.controls.requests.filter(call => call.method !== 'GET' && !(call.method === 'POST' && call.path === 'task/undone'));
    assert.deepEqual(writes, []);
    assert.deepEqual(driver.errors, []);
  } finally {
    try { await driver.close(); }
    finally { await provider.close(); }
  }
}
