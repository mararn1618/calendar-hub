import assert from 'node:assert/strict';
import { until } from './desktop-driver.mjs';
import { civilDay } from './provider-server.mjs';

export async function verifyNotificationJourneys({ page, provider, refresh, restart, screenshot }) {
  const { notifications } = provider;
  const tomorrow = new Date(provider.day + 'T12:00:00');
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = civilDay(tomorrow);
  const at = hour => new Date(day + 'T' + hour + ':00').toISOString();
  const task = { id: 'notification-task', projectId: 'planning', title: 'Read the workshop proposal', status: 0,
    startDate: at('15:00'), dueDate: at('15:30'), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    isAllDay: false, reminders: ['TRIGGER:-PT2H'] };
  const event = { id: 'notification-event', summary: 'Workshop introduction', status: 'confirmed', etag: '"1"',
    start: { dateTime: at('16:00') }, end: { dateTime: at('17:00') }, organizer: { self: true },
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }] } };
  const allDay = { id: 'notification-allday', summary: 'Workshop day', status: 'confirmed',
    start: { date: day }, end: { date: civilDay(new Date(tomorrow.getTime() + 86_400_000)) } };
  const errand = { ...task, id: 'notification-errand', projectId: 'errands', title: 'Pick up the workshop prints' };
  provider.originals.set(task.id, task);
  provider.originals.set(errand.id, errand);
  const studioEvents = provider.events.get('studio@example.test');
  studioEvents.set(event.id, event);
  studioEvents.set(allDay.id, allDay);
  const taskReminder = structuredClone(task.reminders);
  const eventReminder = structuredClone(event.reminders);
  const writesAtSource = () => provider.controls.requests.filter(call => call.method !== 'GET' &&
    !(call.provider === 'ticktick' && call.path === 'task/undone')).length;
  const writesBefore = writesAtSource();
  const sidebar = () => page.locator('#source-list');
  const bell = name => sidebar().getByRole('button', { name: 'Notifications for ' + name, exact: true });
  const visibility = name => sidebar().getByRole('checkbox', { name, exact: true });
  const matching = title => [...notifications.pending.values()].filter(note => note.title === title);
  async function checked(name, enabled) {
    await until(async () => await bell(name).getAttribute('aria-pressed') === String(enabled), 'Bell did not update for ' + name);
  }
  async function pending(title, start, minutes) {
    const time = Date.parse(start) - minutes * 60_000;
    await until(() => matching(title).length === 1 && Date.parse(matching(title)[0].fireAt) === time,
      'Incorrect pending system reminder for ' + title);
  }
  async function groupBy(mode) {
    await sidebar().getByRole('button', { name: 'Edit TickTick lists', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'TickTick calendars', exact: true });
    await picker.getByRole('button', { name: mode, exact: true }).click();
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
  }

  await checked('TickTick', false);
  await checked('Studio', false);
  assert.equal(notifications.prompts, 0);
  assert.equal(notifications.pending.size, 0);
  notifications.decision = 'denied';
  await bell('TickTick').click();
  await until(() => notifications.prompts === 1, 'The first opt-in did not ask for permission.');
  await checked('TickTick', false);
  await page.getByText(/System Settings.*Notifications/i).first().waitFor();
  assert.equal(notifications.pending.size, 0);

  notifications.authorization = 'undetermined';
  notifications.decision = 'allowed';
  await bell('TickTick').click();
  await checked('TickTick', true);
  await pending(task.title, task.startDate, 10);
  assert.equal(notifications.prompts, 2);
  await visibility('TickTick').uncheck();
  await until(async () => !(await visibility('TickTick').isChecked()) && await visibility('TickTick').isEnabled(), 'Calendar did not hide.');
  await pending(task.title, task.startDate, 10);
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await bell('TickTick').click({ button: 'right' });
  const timing = page.getByRole('menu', { name: 'Notification timing' });
  await screenshot(page, 'calendar-bell-timing');
  await timing.getByRole('menuitemradio', { name: '15 minutes before', exact: true }).click();
  await pending(task.title, task.startDate, 15);

  await page.getByRole('button', { name: 'Manage calendars', exact: true }).first().click();
  await page.getByRole('button', { name: 'Notification settings for Studio', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Calendar notifications' });
  await settings.getByRole('checkbox', { name: 'Enable notifications' }).check();
  await settings.getByRole('spinbutton', { name: 'Minutes before start' }).fill('23');
  await screenshot(page, 'calendar-notification-settings');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await pending(event.summary, event.start.dateTime, 23);
  await page.getByRole('dialog', { name: 'Calendars', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(notifications.prompts, 2);
  assert.equal(matching(allDay.summary).length, 0);
  page = await restart();
  await checked('Studio', true);
  await checked('TickTick', true);
  await pending(task.title, task.startDate, 15);
  await pending(event.summary, event.start.dateTime, 23);

  await groupBy('By folder');
  await checked('Work', false);
  await checked('Personal', false);
  await until(() => !matching(task.title).length && !matching(errand.title).length, 'The old account calendar still has pending notifications.');
  await bell('Work').click();
  await pending(task.title, task.startDate, 10);
  assert.equal(matching(errand.title).length, 0);
  await pending(event.summary, event.start.dateTime, 23);
  await groupBy('One calendar');
  await checked('TickTick', true);
  await pending(task.title, task.startDate, 15);
  await pending(errand.title, errand.startDate, 15);

  event.start.dateTime = at('17:30');
  event.end.dateTime = at('18:15');
  event.etag = '"2"';
  await refresh(page);
  await pending(event.summary, event.start.dateTime, 23);
  task.status = 2;
  await refresh(page);
  await until(() => !matching(task.title).length, 'A completed task still has a pending notification.');
  await pending(event.summary, event.start.dateTime, 23);
  await bell('Studio').click();
  await checked('Studio', false);
  assert.equal(matching(event.summary).length, 0);
  await bell('TickTick').click();
  await checked('TickTick', false);
  await visibility('TickTick').check();
  await until(() => notifications.pending.size === 0, 'Muted calendars still have pending notifications.');
  assert.deepEqual(task.reminders, taskReminder);
  assert.deepEqual(event.reminders, eventReminder);
  assert.equal(writesAtSource(), writesBefore, 'Notification controls sent a write to a calendar provider.');
  return page;
}
