import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
export const appPath = join(root, 'build/packaged', 'Calendar Hub-darwin-' + process.arch, 'Calendar Hub.app');
export async function until(check, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(60);
  } while (Date.now() < deadline);
  throw new Error(message);
}

export async function refresh(page) {
  const timeline = page.locator('#timeline');
  const previous = Number(await timeline.getAttribute('data-refresh-count') || 0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await until(async () => Number(await timeline.getAttribute('data-refresh-count')) > previous, 'Calendar refresh did not finish.');
}

export async function createItem(page, { title, calendar, calendarValue, allDay = true, day, hour = 9 }) {
  await page.locator('#new-item').click();
  const form = page.locator('#item-form');
  await form.getByLabel('Title', { exact: true }).fill(title);
  await form.locator('#item-calendar').selectOption(calendarValue ? { value: calendarValue } : { label: calendar });
  await form.getByLabel('All day', { exact: true }).setChecked(allDay);
  if (day) {
    await form.getByLabel('Start date', { exact: true }).fill(day);
    await form.getByLabel('End date', { exact: true }).fill(day);
  }
  if (!allDay) {
    const hh = String(hour).padStart(2, '0');
    await form.getByLabel('Start time', { exact: true }).fill(hh + ':00');
    await form.getByLabel('End time', { exact: true }).fill(hh + ':30');
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

export class DesktopDriver {
  constructor({ evidenceDirectory, configPath, profileDirectory, startupTimeout = 30_000 } = {}) {
    this.evidenceDirectory = evidenceDirectory;
    this.configPath = configPath;
    this.profileDirectory = profileDirectory;
    this.startupTimeout = startupTimeout;
    this.errors = [];
  }
  async launch() {
    const args = this.configPath ? ['--calendar-test-config=' + this.configPath] : [];
    if (this.profileDirectory) args.push('--user-data-dir=' + this.profileDirectory);
    this.application = await electron.launch({
      executablePath: join(appPath, 'Contents/MacOS/Calendar Hub'), args, timeout: this.startupTimeout
    });
    this.page = await this.application.firstWindow({ timeout: this.startupTimeout });
    this.page.setDefaultTimeout(this.startupTimeout);
    this.page.on('pageerror', error => this.errors.push(error.message));
    await this.page.locator('#timeline').waitFor({ state: 'attached', timeout: this.startupTimeout });
    await until(async () => Number(await this.page.locator('#timeline').getAttribute('data-refresh-count')) > 0,
      'The packaged calendar window did not load its first state.', this.startupTimeout);
    this.page.setDefaultTimeout(15_000);
    return this.page;
  }
  async restart() {
    await this.close();
    return this.launch();
  }
  async close() {
    if (!this.application) return;
    await this.application.close();
    this.application = undefined;
  }
  async screenshot(page, name) {
    await mkdir(this.evidenceDirectory, { recursive: true });
    await page.screenshot({ path: join(this.evidenceDirectory, name + '.png') });
  }
  async dragTo({ itemId, sourceId, day, hour, minute = 0, edge }) {
    const page = this.page, viewport = page.locator('#timeline');
    const sourceSelector = sourceId ? '[data-source-id=' + JSON.stringify(sourceId) + ']' : '';
    const block = viewport.locator('[data-item-id=' + JSON.stringify(itemId) + ']' + sourceSelector).first();
    await block.waitFor();
    const col = viewport.locator('.day-column[data-date="' + day + '"]');
    const clock = col.locator('.hour-line[data-time="' + String(hour).padStart(2, '0') + ':00"]').first();
    const nextClock = col.locator('.hour-line[data-time="' + String((hour + 1) % 24).padStart(2, '0') + ':00"]').first();
    const isAllDay = await block.evaluate(node => node.classList.contains('all-day-item'));
    if (isAllDay) await block.scrollIntoViewIfNeeded();
    const measure = async () => {
      const [origin, target, after, area, header] = await Promise.all([
        block.boundingBox(), clock.boundingBox(), nextClock.boundingBox(), viewport.boundingBox(), viewport.locator('.timeline-header').boundingBox()
      ]);
      assert(origin && target && after && area && header, 'Dragged item and target must be on the current calendar.');
      const ppm = hour === 23 ? 1.1 : (after.y - target.y) / 60;
      const grip = Math.min(12, Math.max(6, origin.height / 2));
      const y = target.y + minute * ppm + (edge || isAllDay ? 0 : grip);
      return { origin, target, area, header, y, grip };
    };
    let bounds = await measure();
    if (bounds.y < bounds.header.y + bounds.header.height + 35 || bounds.y > bounds.area.y + bounds.area.height - 35) {
      await viewport.hover();
      const middle = bounds.area.y + bounds.area.height * 0.54;
      await page.mouse.wheel(0, bounds.y - middle);
      await until(async () => {
        bounds = await measure();
        return bounds.y > bounds.header.y + bounds.header.height + 26 && bounds.y < bounds.area.y + bounds.area.height - 30;
      }, 'The target hour could not be scrolled into view.');
    }
    if (isAllDay) await block.hover();
    bounds = await measure();
    const handle = edge ? await block.locator('[data-edge="' + edge + '"]').boundingBox() : null;
    const { origin, target, y, grip } = bounds;
    assert(!edge || handle, 'Resize handle must exist for this source.');
    const sourceX = handle ? handle.x + handle.width / 2 : origin.x + origin.width / 2;
    const sourceY = handle ? handle.y + handle.height / 2 : origin.y + grip;
    assert(await block.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), { x: sourceX, y: sourceY }),
      'The drag must start on the requested item.');
    await page.mouse.move(sourceX, sourceY);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width * 0.53, y + 0.5, { steps: 12 });
    const destination = await measure();
    await page.mouse.move(destination.target.x + destination.target.width * 0.53, destination.y + 0.5);
    await page.mouse.up();
  }
}
