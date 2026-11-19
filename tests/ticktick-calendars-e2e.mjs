import assert from 'node:assert/strict';

const checkbox = (area, name) => area.getByRole('checkbox', { name, exact: true });
const button = (area, name) => area.getByRole('button', { name, exact: true });

export async function expandFolder(dialog, name) {
  const expand = button(dialog, 'Expand ' + name);
  const collapse = button(dialog, 'Collapse ' + name);
  await expand.or(collapse).waitFor();
  if (await expand.isVisible()) await expand.click();
}

async function assertOrder(locators) {
  const positions = [];
  for (const locator of locators) {
    await locator.waitFor({ state: 'attached' });
    positions.push(await locator.evaluate(node => [...document.querySelectorAll('*')].indexOf(node)));
  }
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'Rows should follow their order in TickTick.');
}

export async function verifyTickTickCalendars({ page, provider, restart, refresh, createItem, screenshot }) {
  const sidebar = () => page.locator('#source-list');
  const picker = () => page.getByRole('dialog', { name: 'TickTick calendars', exact: true });
  const openPicker = () => button(sidebar(), 'Edit TickTick lists').click();
  const item = id => page.locator('[data-item-id="' + id + '"]');
  const included = name => checkbox(picker(), name);
  const tickCalendar = name => checkbox(sidebar(), name);
  const save = async () => {
    await button(picker(), 'Save').click();
    await picker().waitFor({ state: 'hidden' });
  };

  assert.equal(await tickCalendar('TickTick').isChecked(), true);
  for (const name of ['Planning tasks', 'Errands', 'Inbox', 'Work']) assert.equal(await tickCalendar(name).count(), 0);
  for (const id of ['inbox-one', 'review', 'brief-task', 'errand-task']) await item(id).waitFor();
  assert.equal(await item('closed-task').count(), 0);
  const originalSource = await item('review').getAttribute('data-source-id');
  assert.ok(originalSource);
  await screenshot(page, 'ticktick-account-sidebar');

  await openPicker();
  assert.equal(await button(picker(), 'One calendar').getAttribute('aria-pressed'), 'true');
  assert.equal(await included('All active and future lists').isChecked(), true);
  await expandFolder(picker(), 'Work');
  await assertOrder(['Inbox', 'Templates', 'Select folder Work', 'Briefs', 'Planning tasks', 'On my desk', 'Select folder Personal', 'Select folder Archive'].map(included));
  await screenshot(page, 'ticktick-list-folders');
  await included('Select folder Work').uncheck();
  assert.equal(await included('Briefs').isChecked(), false);
  assert.equal(await included('Planning tasks').isChecked(), false);
  await included('Select folder Work').check();
  const search = picker().getByRole('searchbox', { name: 'Search lists' });
  await search.fill('erra');
  assert.equal(await included('Errands').isChecked(), true);
  assert.equal(await included('Planning tasks').isVisible(), false);
  await included('Errands').uncheck();
  await save();
  await item('errand-task').waitFor({ state: 'detached' });
  await item('review').waitFor();

  const requestsBeforeToggle = provider.controls.requests.length;
  await tickCalendar('TickTick').uncheck();
  await item('review').waitFor({ state: 'detached' });
  await item('studioevent').waitFor();
  await tickCalendar('TickTick').check();
  await item('review').waitFor();
  assert.equal(await item('errand-task').count(), 0);
  assert.equal(provider.controls.requests.length, requestsBeforeToggle, 'Toggling a recently loaded account should use its current items.');
  page = await restart();
  await item('brief-task').waitFor();
  assert.equal(await item('errand-task').count(), 0);
  await openPicker();
  await expandFolder(picker(), 'Personal');
  assert.equal(await included('Errands').isChecked(), false);
  await included('All active and future lists').check();
  await button(picker(), 'By folder').click();
  await save();
  for (const name of ['Work', 'Personal', 'Archive', 'Unfiled lists']) assert.equal(await tickCalendar(name).isChecked(), true);
  await tickCalendar('Work').uncheck();
  await item('review').waitFor({ state: 'detached' });
  await item('errand-task').waitFor();
  await item('inbox-one').waitFor();
  await tickCalendar('Work').check();
  await item('review').waitFor();
  assert.equal(await item('review').getAttribute('data-source-id'), originalSource);

  await openPicker();
  await button(picker(), 'Custom calendars').click();
  await button(picker(), 'Add calendar').click();
  const custom = page.getByRole('dialog', { name: 'Add calendar' });
  await custom.getByRole('textbox', { name: 'Calendar name' }).fill('Focus');
  await expandFolder(custom, 'Work');
  await checkbox(custom, 'Planning tasks').check();
  await expandFolder(custom, 'Personal');
  await checkbox(custom, 'Errands').check();
  await button(custom, 'Done').click();
  await save();
  await tickCalendar('Focus').waitFor();
  await tickCalendar('Focus').uncheck();
  await item('review').waitFor({ state: 'detached' });
  await item('errand-task').waitFor({ state: 'detached' });
  await item('brief-task').waitFor();
  page = await restart();
  assert.equal(await tickCalendar('Focus').isChecked(), false);
  assert.equal(await item('errand-task').count(), 0);
  await tickCalendar('Focus').check();
  await item('errand-task').waitFor();
  assert.equal(await item('review').count(), 1);
  assert.equal(await item('review').getAttribute('data-source-id'), originalSource);
  await screenshot(page, 'ticktick-custom-calendars');
  await createItem(page, { title: 'Collect the printed proof', calendar: 'Errands', day: provider.day });
  await page.getByRole('button', { name: 'Collect the printed proof', exact: true }).waitFor();
  const created = [...provider.originals.values()].filter(task => task.title === 'Collect the printed proof');
  assert.deepEqual(created.map(task => task.projectId), ['errands']);

  const work = provider.projectGroups.find(folder => folder.id === 'work');
  const briefs = provider.projects.find(list => list.id === 'briefs');
  const previousOrder = work.sortOrder;
  work.name = 'Studio work';
  work.sortOrder = 500;
  briefs.groupId = 'personal';
  await refresh(page);
  assert.equal(await tickCalendar('Focus').isChecked(), true);
  assert.equal(await item('review').getAttribute('data-source-id'), originalSource);
  await openPicker();
  await button(picker(), 'One calendar').click();
  await expandFolder(picker(), 'Personal');
  await assertOrder(['Templates', 'On my desk', 'Select folder Personal', 'Briefs', 'Errands', 'Select folder Studio work', 'Select folder Archive'].map(included));
  await button(picker(), 'Cancel').click();
  assert.equal(await tickCalendar('Focus').isChecked(), true);
  work.name = 'Work';
  work.sortOrder = previousOrder;
  briefs.groupId = 'work';
  await refresh(page);

  await openPicker();
  await button(picker(), 'One calendar').click();
  await save();
  await refresh(page);
  assert.equal(await tickCalendar('TickTick').isChecked(), true);
  assert.equal(await item('review').count(), 1);
  return page;
}
