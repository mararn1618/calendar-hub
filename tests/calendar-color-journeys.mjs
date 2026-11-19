import assert from 'node:assert/strict';

const button = (area, name) => area.getByRole('button', { name, exact: true });
const picker = page => page.getByRole('dialog', { name: 'Calendar color', exact: true });

export function colorControl(page, name, account) {
  const sidebar = page.locator('#source-list');
  return button(account ? sidebar.getByRole('group', { name: account, exact: true }) : sidebar, 'Change color for ' + name);
}

export async function chooseCalendarColor(page, name, color, account) {
  await colorControl(page, name, account).press('Enter');
  const dialog = picker(page);
  if (color === null) await button(dialog, 'Use default color').click();
  else {
    const hex = dialog.getByRole('textbox', { name: 'Hex color' });
    await hex.fill(color);
    await hex.press('Enter');
  }
  await dialog.waitFor({ state: 'hidden' });
}

export function displayedColor(target) {
  return target.evaluate(node => getComputedStyle(node).getPropertyValue('--source-color').trim().toLowerCase());
}

export function textContrast(target) {
  return target.evaluate(node => {
    const style = getComputedStyle(node);
    const ctx = document.createElement('canvas').getContext('2d');
    const surface = getComputedStyle(node.closest('.day-column, .all-day-cell') || document.documentElement).backgroundColor;
    function luminance(color) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = surface;
      ctx.fillRect(0, 0, 1, 1);
      ctx.globalAlpha = Number(style.opacity);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = [...ctx.getImageData(0, 0, 1, 1).data].map(value => {
        const c = value / 255;
        return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
      });
      return r * .2126 + g * .7152 + b * .0722;
    }
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
}

export async function verifyCalendarColors({ page, provider, refresh, restart, screenshot }) {
  const item = id => page.locator('.calendar-item[data-item-id="' + id + '"]');
  const check = name => page.locator('#source-list').getByRole('checkbox', { name, exact: true });
  const tickDefault = await displayedColor(item('review'));
  const googleDefault = await displayedColor(item('studioevent'));
  const otherColor = await displayedColor(item('bmwmeeting'));
  const writes = () => provider.controls.requests.filter(request => request.method !== 'GET').length;
  const before = writes();
  await chooseCalendarColor(page, 'TickTick', '#FFFFFF');
  assert.equal(await colorControl(page, 'TickTick').evaluate(node => document.activeElement === node), true);
  await colorControl(page, 'Studio').click();
  const dialog = picker(page);
  assert.equal(await button(dialog, 'Use default color').isDisabled(), true);
  await dialog.getByLabel('Pick a color', { exact: true }).fill('#000000');
  assert.equal(await dialog.getByLabel('Hex color', { exact: true }).inputValue(), '#000000');
  await screenshot(page, 'calendar-custom-color');
  await button(dialog, 'Save').click();
  await dialog.waitFor({ state: 'hidden' });
  for (const id of ['review', 'timed']) {
    assert.equal(await displayedColor(item(id)), '#ffffff');
    assert.equal(await item(id).evaluate(node => getComputedStyle(node).borderLeftColor), 'rgb(255, 255, 255)');
  }
  assert.equal(await displayedColor(item('studioevent')), '#000000');
  assert.equal(await displayedColor(item('bmwmeeting')), otherColor);
  assert.equal(await check('TickTick').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await colorControl(page, 'Studio').evaluate(node => getComputedStyle(node, '::before').backgroundColor), 'rgb(0, 0, 0)');

  async function selectTheme(name) {
    await page.locator('#manage-calendars').click();
    const settings = page.getByRole('dialog', { name: 'Calendars', exact: true });
    await settings.getByRole('radio', { name, exact: true }).check();
    await button(settings, 'Done').click();
  }
  for (const name of ['Light', 'Dark']) {
    await selectTheme(name);
    for (const target of [item('review'), item('studioevent'), check('Studio'), check('TickTick')]) {
      assert(await textContrast(target) >= 4.5, 'Calendar text and checkmarks need enough contrast in ' + name);
    }
  }
  await selectTheme('Light');
  await item('review').click();
  const editor = page.getByRole('dialog', { name: 'Edit task' });
  assert.equal(await displayedColor(editor.locator('.destination-context')), '#ffffff');
  await button(editor, 'Cancel').click();
  await check('TickTick').uncheck();
  await item('review').waitFor({ state: 'detached' });
  await refresh(page);
  page = await restart();
  assert.equal(await check('TickTick').isChecked(), false);
  assert.equal(await displayedColor(colorControl(page, 'TickTick')), '#ffffff');
  assert.equal(await displayedColor(item('studioevent')), '#000000');
  await check('TickTick').check();
  await item('review').waitFor();
  assert.equal(await displayedColor(item('review')), '#ffffff');
  await chooseCalendarColor(page, 'TickTick', null);
  await chooseCalendarColor(page, 'Studio', null);
  assert.equal(await displayedColor(item('review')), tickDefault);
  assert.equal(await displayedColor(item('studioevent')), googleDefault);
  assert.equal(writes(), before, 'Calendar colors must stay local.');
  return page;
}
