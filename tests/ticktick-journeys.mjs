import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const clock = (day, hhmm) => Date.parse(day + 'T' + hhmm + ':00')
const nextDay = day => new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10)

async function waitForProvider(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await delay(25)
  }
  assert.fail(typeof message === 'function' ? message() : message)
}

async function showThreeDays(page, through) {
  await page.getByRole('button', { name: 'Next X Days', exact: true }).click()
  const count = page.getByRole('spinbutton', { name: 'Number of days' })
  if (await count.inputValue() !== '3') {
    await count.fill('3')
    await count.press('Tab')
  }
  await page.locator('.day-column[data-date="' + through + '"]').waitFor()
}

export async function verifyTickTickJourneys({ page, provider, dragTo, restart, refresh, screenshot, createItem }) {
  const { day, originals, controls } = provider
  const tomorrow = nextDay(day)
  const baseline = structuredClone(originals.get('review'))
  const selectItem = (date, className = 'calendar-item') => page.locator('.' + className + '[data-item-id="review"][data-date="' + date + '"]')
  const checkOriginal = () => {
    const task = originals.get('review')
    for (const key of ['id', 'projectId', 'title', 'content', 'items', 'tags', 'priority']) {
      assert.deepEqual(task[key], baseline[key], 'Original task field changed: ' + key)
    }
    assert.equal([...originals.values()].filter(row => row.title === baseline.title).length, 1)
  }
  async function checkSchedule(date, start, end) {
    const expectedStart = clock(date, start)
    const expectedEnd = clock(date, end)
    await waitForProvider(() => {
      const task = originals.get('review')
      return task.isAllDay === false && Date.parse(task.startDate) === expectedStart && Date.parse(task.dueDate) === expectedEnd
    }, () => 'Expected original TickTick task at ' + date + ' ' + start + ' to ' + end + ', got ' + JSON.stringify(originals.get('review')))
    checkOriginal()
    await selectItem(date, 'timed-item').and(page.locator('[aria-description*="' + start + '"][aria-description*="' + end + '"]')).waitFor()
  }

  await selectItem(day, 'all-day-item').waitFor()
  assert.equal(baseline.isAllDay, true)
  await dragTo({ itemId: 'review', day, hour: 10 })
  await checkSchedule(day, '10:00', '10:30')
  await dragTo({ itemId: 'review', day, edge: 'end', hour: 11, minute: 15 })
  await checkSchedule(day, '10:00', '11:15')

  await showThreeDays(page, tomorrow)
  await dragTo({ itemId: 'review', day: tomorrow, hour: 11 })
  await checkSchedule(tomorrow, '11:00', '12:15')
  await screenshot(page, 'ticktick-task-planned')
  await selectItem(tomorrow).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Complete task', exact: true }).click()
  await waitForProvider(() => originals.get('review').status === 2, 'Original TickTick task did not complete')
  await selectItem(tomorrow).waitFor({ state: 'detached' })
  checkOriginal()
  assert.equal(Date.parse(originals.get('review').dueDate) - Date.parse(originals.get('review').startDate), 75 * 60_000)

  const uncertainTitle = 'Review workshop slides'
  const matchingCreates = () => controls.requests.filter(request => request.provider === 'ticktick' && request.method === 'POST' && request.path === 'task').length
  const savedTasks = () => [...originals.values()].filter(row => row.title === uncertainTitle)
  const before = matchingCreates()
  controls.noTickId = true
  const draft = { title: uncertainTitle, calendar: 'Planning tasks', allDay: true, day }
  await createItem(page, draft)
  const reviewDialog = () => page.getByRole('dialog', { name: 'Review unconfirmed writes' })
  const reviewEntry = () => reviewDialog().locator('.review-entry').filter({ hasText: uncertainTitle })
  await reviewEntry().waitFor()
  assert.match(await reviewEntry().innerText(), /without returning a task ID/i)
  assert.equal(matchingCreates(), before + 1)
  assert.equal(savedTasks().length, 1)
  const createdId = savedTasks()[0].id
  assert.equal(savedTasks()[0].projectId, baseline.projectId)
  await screenshot(page, 'ticktick-unconfirmed-create')
  page = await restart()

  await page.getByRole('button', { name: 'Review writes', exact: true }).click()
  await reviewEntry().waitFor()
  await reviewDialog().getByRole('button', { name: 'Done', exact: true }).click()
  await showThreeDays(page, tomorrow)
  await refresh(page)
  await page.getByRole('button', { name: uncertainTitle, exact: true }).waitFor()
  assert.equal(await selectItem(tomorrow).count(), 0)
  assert.equal(originals.get('review').status, 2)
  checkOriginal()
  assert.equal(matchingCreates(), before + 1)

  await createItem(page, draft)
  await reviewEntry().waitFor()
  assert.equal(matchingCreates(), before + 1)
  assert.deepEqual(savedTasks().map(row => row.id), [createdId])
  await reviewEntry().getByRole('button', { name: 'Mark reviewed' }).click()
  const confirmation = page.getByRole('dialog', { name: 'Mark write as reviewed?' })
  await confirmation.getByRole('button', { name: 'I checked the source' }).click()
  await reviewDialog().getByText('Every write has been reviewed.').waitFor()
  await reviewDialog().getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await refresh(page)
  await page.getByRole('button', { name: uncertainTitle, exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Review writes', exact: true }).count(), 0)
  assert.equal(matchingCreates(), before + 1)
  assert.deepEqual(savedTasks().map(row => row.id), [createdId])
  return page
}
