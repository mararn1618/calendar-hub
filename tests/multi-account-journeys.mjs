import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopDriver, refresh, until } from './desktop-driver.mjs';
import { startProviderServer } from './provider-server.mjs';

const providers = [
  { name: 'Google Calendar', signIn: 'Google', consent: 'Authorize test calendars', labels: ['Studio calendar', 'Field calendar'],
    source: 'BMW Work', item: 'bmwmeeting', entries: account => account.events.get('bmw-copy'), field: 'summary' },
  { name: 'TickTick', signIn: 'TickTick', consent: 'Authorize test tasks', labels: ['Studio tasks', 'Field tasks'],
    source: 'Planning tasks', folder: 'Work', item: 'review', entries: account => account.originals, field: 'title' },
];
const button = (container, name) => container.getByRole('button', { name, exact: true });
const region = (container, name) => container.getByRole('region', { name, exact: true });
const groupLabel = (provider, label) => provider.name + ' · ' + label + (provider.folder ? ' / ' + provider.folder : '');

async function connect(driver, dialog, provider, account, label) {
  await button(dialog, 'Connect ' + provider.name).click();
  await dialog.getByLabel('Account name (optional)', { exact: true }).fill(label);
  const popup = driver.application.waitForEvent('window');
  await button(dialog, 'Continue with ' + provider.signIn).click();
  const consent = await popup;
  await consent.getByLabel('Test account').selectOption(account.id);
  await button(consent, provider.consent).click();
  await region(dialog, label).waitFor();
}

async function destination(page, provider, accountLabel) {
  const dialog = page.getByRole('dialog', { name: 'New item', exact: true });
  const label = groupLabel(provider, accountLabel);
  const group = dialog.locator('optgroup[label=' + JSON.stringify(label) + ']');
  const option = group.getByRole('option', { name: provider.source, exact: true, includeHidden: true });
  const value = await option.getAttribute('value');
  assert.ok(value);
  await dialog.locator('#item-calendar').selectOption(value);
  assert.equal(await dialog.locator('.destination-context').innerText(), label);
  return value;
}

async function create(page, provider, account, title, day) {
  await page.locator('#new-item').click();
  await destination(page, provider, account);
  const editor = page.getByRole('dialog', { name: 'New item', exact: true });
  await editor.getByLabel('Title', { exact: true }).fill(title);
  await editor.getByLabel('All day', { exact: true }).check();
  await editor.getByLabel('Start date', { exact: true }).fill(day);
  await editor.getByLabel('End date', { exact: true }).fill(day);
  await button(editor, 'Save').click();
  await editor.waitFor({ state: 'hidden' });
}

export async function verifyBrowserAccounts({ temporary, evidence }) {
  const directory = await mkdtemp(join(temporary, 'browser-accounts-'));
  const configPath = join(directory, 'config.json');
  const server = await startProviderServer({ multipleAccounts: true });
  const [first, second] = server.accounts;
  const driver = new DesktopDriver({ configPath, evidenceDirectory: evidence });
  try {
    await writeFile(configPath, JSON.stringify({ origin: server.origin }));
    let page = await driver.launch();
    await page.locator('#manage-calendars').click();
    let dialog = page.locator('dialog[open]');
    for (const provider of providers) {
      for (const [index, account] of server.accounts.entries()) {
        const label = provider.labels[index];
        await connect(driver, dialog, provider, account, label);
        if (provider.name === 'Google Calendar') {
          const source = region(dialog, label).getByRole('checkbox', { name: provider.source, exact: true });
          await source.check();
          await until(async () => await source.isChecked() && await button(dialog, 'Done').isEnabled(), 'Calendar selection did not save.');
        }
      }
      await connect(driver, dialog, provider, first, provider.labels[0]);
    }
    assert.equal(await dialog.locator('.connection-group').count(), 4);
    await driver.screenshot(page, 'browser-and-ticktick-accounts');
    await button(dialog, 'Done').click();
    await refresh(page);
    await page.locator('#new-item').click();
    const sources = new Map();
    for (const provider of providers) {
      const values = [];
      for (const label of provider.labels) values.push(await destination(page, provider, label));
      assert.notEqual(values[0], values[1]);
      sources.set(provider, values);
    }
    await driver.screenshot(page, 'browser-and-ticktick-destination');
    await button(dialog, 'Cancel').click();
    for (const provider of providers) {
      const created = 'For ' + provider.labels[1];
      await create(page, provider, provider.labels[1], created, server.day);
      const titles = account => [...provider.entries(account).values()].map(entry => entry[provider.field]);
      assert.equal(titles(second).filter(title => title === created).length, 1);
      assert.ok(!titles(first).includes(created));
    }

    page = await driver.restart();
    dialog = page.locator('dialog[open]');
    await refresh(page);
    for (const provider of providers) {
      const blocks = page.locator('.calendar-item[data-item-id="' + provider.item + '"]');
      assert.deepEqual(new Set(await blocks.evaluateAll(nodes => nodes.map(node => node.dataset.sourceId))), new Set(sources.get(provider)));
      const original = provider.entries(first).get(provider.item)[provider.field];
      const changed = original + ' at ' + provider.labels[1];
      const secondSource = sources.get(provider)[1];
      const target = blocks.and(page.locator('[data-source-id=' + JSON.stringify(secondSource) + ']'));
      assert.ok((await target.getAttribute('aria-description')).includes(provider.labels[1]));
      await target.click();
      await dialog.getByLabel('Title', { exact: true }).fill(changed);
      await button(dialog, 'Save').click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(provider.entries(second).get(provider.item)[provider.field], changed);
      assert.equal(provider.entries(first).get(provider.item)[provider.field], original);
    }
    await page.locator('#manage-calendars').click();
    for (const provider of providers) {
      await button(region(dialog, provider.labels[1]), 'Disconnect').click();
      await button(page.getByRole('dialog', { name: 'Disconnect calendar?', exact: true }), 'Disconnect').click();
      await region(dialog, provider.labels[0]).waitFor();
      assert.equal(await region(dialog, provider.labels[1]).count(), 0);
    }
    assert.equal(await dialog.locator('.connection-group').count(), 2);
    await button(dialog, 'Done').click();
    for (const provider of providers) {
      const title = 'Still connected to ' + provider.labels[0];
      await create(page, provider, provider.labels[0], title, server.day);
      assert.ok([...provider.entries(first).values()].some(row => row[provider.field] === title));
      assert.ok(![...provider.entries(second).values()].some(row => row[provider.field] === title));
    }
    assert.deepEqual(driver.errors, []);
  } catch (error) {
    if (driver.page && !driver.page.isClosed()) await driver.screenshot(driver.page, 'browser-accounts-failure').catch(() => {});
    throw error;
  } finally {
    try { await driver.close(); } finally { await server.close(); }
  }
}
