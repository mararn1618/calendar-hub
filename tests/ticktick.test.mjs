import assert from 'node:assert/strict'
import test from 'node:test'
import { createTickTick } from '../desktop/providers/ticktick.mjs'

const source = { id: 'personal', name: 'Personal', writable: true }
const inbox = { id: 'inbox', name: 'Inbox', writable: true }
const zone = 'Europe/Berlin'
const day = { start: '2026-10-25', end: '2026-10-26' }
const original = {
  id: 'task1', projectId: source.id, title: 'Buy apples', status: 0,
  timeZone: zone, isAllDay: true, dueDate: '2026-10-24T22:00:00+0000',
  content: 'Six apples', desc: 'Market list', tags: ['market'], reminders: ['TRIGGER:PT0S'],
  priority: 3, parentId: 'parent', items: [{ id: 'apple', title: 'Apples', status: 1, sortOrder: 1 }],
}

function response(value, status = 200) {
  return new Response(value == null ? null : JSON.stringify(value), { status })
}

function api(handle) {
  const calls = []
  const client = createTickTick({
    token: 'fixture', apiBase: 'https://example.invalid/open/v1/', timeZone: zone,
    fetchImpl: async (uri, options) => {
      const url = new URL(uri)
      const path = url.pathname.slice('/open/v1'.length)
      const body = options.body && JSON.parse(options.body)
      assert.equal(options.headers.Authorization, 'Bearer fixture')
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal instanceof AbortSignal)
      const call = { path, query: url.searchParams, method: options.method, body }
      calls.push(call)
      return handle(call)
    },
  })
  return { client, calls }
}

test('lists every page and keeps read, comment and archived lists read-only', async () => {
  const projects = Array.from({ length: 200 }, (_, i) => ({ id: 'p' + i, name: 'List ' + i }))
  const { client, calls } = api(({ path, query }) => {
    assert.equal(path, '/project')
    assert.equal(query.get('limit'), '200')
    return response(query.get('offset') === '0' ? projects : [
      { id: 'shared', name: 'Shared', permission: 'comment' }, { id: 'read', name: 'Read', permission: 'read' },
      { id: 'old', name: 'Old', closed: true }, { id: 'notes', name: 'Notes', kind: 'NOTE' },
    ])
  })
  const lists = await client.sources()
  assert.equal(calls.length, 2)
  assert.equal(lists[0].id, 'inbox')
  assert(lists.find(p => p.id === 'p199').writable)
  assert(lists.filter(p => ['read', 'shared', 'old'].includes(p.id)).every(p => !p.writable))
  assert(!lists.find(p => p.id === 'notes'))
})

test('reads undated, date-only, point and overlapping ranges across the autumn clock change', async () => {
  const tasks = [
    original, { ...original, id: 'plain', dueDate: '2026-10-25', isAllDay: undefined },
    { ...original, id: 'undated', dueDate: null }, { ...original, id: 'done', status: 2 },
    { ...original, id: 'point', dueDate: undefined, startDate: '2026-10-25T00:30:00Z', isAllDay: false },
    { ...original, id: 'later', dueDate: '2026-10-25T02:30:00+0100', isAllDay: false },
    { ...original, id: 'end-boundary', dueDate: '2026-10-26T00:00:00+0100', isAllDay: false },
    { ...original, id: 'multi', startDate: '2026-10-23', dueDate: '2026-10-27' },
    { ...original, id: 'ongoing', startDate: '2026-10-23T10:00:00+0200', dueDate: '2026-10-27T10:00:00+0100', isAllDay: false },
    { ...original, id: 'repeat', repeatFlag: 'RRULE:FREQ=DAILY', repeatFrom: 1 },
  ]
  const { client, calls } = api(() => response({ project: { id: source.id }, tasks }))
  const byId = Object.fromEntries((await client.items(source, day.start, day.end)).map(item => [item.id, item]))
  assert.deepEqual(Object.keys(byId), ['task1', 'plain', 'point', 'later', 'multi', 'ongoing', 'repeat'])
  assert.equal(byId.task1.start, day.start)
  assert.equal(byId.task1.end, day.end)
  assert.equal(byId.plain.allDay, true)
  assert.equal(byId.point.start, '2026-10-25T00:30:00.000Z')
  assert.equal(byId.point.end, byId.point.start)
  assert.equal(byId.later.start, '2026-10-25T01:30:00.000Z')
  assert.equal(byId.multi.end, '2026-10-28')
  assert.equal(byId.ongoing.end, '2026-10-27T09:00:00.000Z')
  assert.equal(byId.repeat.canEdit, false)
  assert.equal(byId.repeat.canComplete, false)
  await assert.rejects(client.update(source, byId.repeat, { occurrence: true }), /repeating/)
  await assert.rejects(client.complete(source, byId.repeat), /repeating/)
  await assert.rejects(client.complete({ ...source, writable: false }, byId.task1), /read-only/)
  assert.equal(calls.length, 1)
})

test('searches long Inbox ranges without gaps, deduplicates tasks and completes by the confirmed ID', async () => {
  const task = { ...original, projectId: 'inbox123456' }
  const { client, calls } = api(({ path, body }) => {
    if (path === '/task/undone') return response([task])
    if (path === '/project/inbox123456/task/task1') return response(task)
    assert.equal(path, '/task/completeTasks')
    assert.deepEqual(body, { taskIds: ['task1'] })
    return response(['task1'])
  })
  const result = await client.items(inbox, '2026-10-20', '2026-11-22')
  assert.equal(result.length, 1)
  let cursor = Date.parse('2026-10-20T00:00:00+02:00')
  for (const { body } of calls) {
    assert.deepEqual(body.projectIds, ['inbox'])
    assert.equal(Date.parse(body.startDate), cursor)
    const next = Date.parse(body.endDate) + 1
    assert(next > cursor && next - cursor <= 14 * 86400000)
    cursor = next
  }
  assert.equal(cursor, Date.parse('2026-11-22T00:00:00+01:00'))
  const completed = await client.complete(inbox, result[0])
  assert.equal(completed.id, 'task1')
  assert.equal(completed.completed, true)
})

test('uses the published Inbox project ID for creation or verifies the alias by ID within Inbox', async () => {
  const draft = { title: 'Follow up', allDay: true, ...day }
  const { client } = api(({ path, body }) => {
    if (path === '/task/undone') return response([{ ...original, projectId: 'inbox123' }])
    assert.equal(path, '/task')
    assert.equal(body.projectId, 'inbox123')
    return response({ ...body, id: 'new' })
  })
  assert.equal((await client.create(inbox, draft)).id, 'new')
  const cold = api(({ path, body }) => {
    if (path === '/task/undone') return response([])
    assert.equal(body.projectId, 'inbox')
    return response({ ...body, id: 'elsewhere', projectId: 'another-list' })
  })
  await assert.rejects(cold.client.create(inbox, draft), { code: 'UNCERTAIN', providerId: 'elsewhere' })
  assert.equal(cold.calls.filter(call => call.path === '/task').length, 1)
  assert.deepEqual(cold.calls.at(-1).body.taskIds, ['elsewhere'])
})

test('moves and resizes the original, keeps details and confirms completion by ID and status', async () => {
  let task = structuredClone(original)
  const { client, calls } = api(({ path, method, body }) => {
    if (path === '/project/personal/data') return response({ tasks: [task] })
    if (path === '/project/personal/task/task1' && method === 'GET') return response(task)
    if (path === '/project/personal/task/task1/complete') {
      task.status = 2
      return response(null)
    }
    assert.equal(path, '/task/task1')
    assert.equal(method, 'POST')
    assert.equal(body.id, task.id)
    assert.equal(body.projectId, task.projectId)
    task = { ...body, status: task.status }
    return response(null, 201)
  })
  let [item] = await client.items(source, day.start, day.end)
  const moving = {
    title: original.title, allDay: false, start: '2026-10-25T02:30:00+0200', end: '2026-10-25T02:30:00+0100',
  }
  item = await client.update(source, item, moving)
  assert.equal(item.id, original.id)
  assert.equal(item.start, '2026-10-25T00:30:00.000Z')
  assert.equal(item.end, '2026-10-25T01:30:00.000Z')
  assert.equal(task.startDate, '2026-10-25T02:30:00+0200')
  assert.equal(task.dueDate, '2026-10-25T02:30:00+0100')
  item = await client.update(source, item, { ...moving, end: '2026-10-26T11:00:00+0100' })
  assert.equal(task.dueDate, '2026-10-26T11:00:00+0100')
  item = await client.update(source, item, { title: original.title, allDay: true, start: '2026-10-24', end: '2026-10-27' })
  assert.equal(task.startDate, '2026-10-24T00:00:00+0200')
  assert.equal(task.dueDate, '2026-10-26T00:00:00+0100')
  for (const key of ['id', 'projectId', 'title', 'content', 'desc', 'items', 'tags', 'priority', 'parentId', 'reminders']) {
    assert.deepEqual(task[key], original[key])
  }
  const completed = await client.complete(source, item)
  assert.equal(completed.completed, true)
  assert.equal(completed.canComplete, false)
  assert.equal(task.status, 2)
  assert.equal(calls.filter(call => call.path === '/task').length, 0)
  assert.equal(calls.at(-1).method, 'GET')
})

test('compares the loaded task before posting and preserves additional detail fields', async () => {
  let task = structuredClone(original)
  const list = structuredClone(task)
  delete list.desc
  const { client, calls } = api(({ path, body }) => {
    if (path.endsWith('/data')) return response({ tasks: [list] })
    if (path.startsWith('/project/')) return response(task)
    task = { ...body }
    return response(task)
  })
  const [item] = await client.items(source, day.start, day.end)
  task.content = 'Eight apples'
  await assert.rejects(client.update(source, item, { ...day, allDay: true }), { code: 'CONFLICT' })
  await assert.rejects(client.complete(source, item), { code: 'CONFLICT' })
  assert.equal(calls.filter(call => call.method === 'POST').length, 0)
  task.content = original.content
  const changed = await client.update(source, item, { ...day, title: 'Buy pears', allDay: true })
  assert.equal(changed.title, 'Buy pears')
  assert.equal(task.desc, original.desc)
  assert.equal(task.dueDate, original.dueDate)
  assert.equal(task.startDate, undefined)
})

test('creates in the selected list and retains the original encoding of timed points on move', async () => {
  let task
  const { client } = api(({ path, body }) => {
    if (path === '/task' || path === '/task/newtask') {
      task = { ...body, id: 'newtask' }
      return response(task)
    }
    if (path.endsWith('/data')) return response({ tasks: [task] })
    return response(task)
  })
  const created = await client.create(source, { title: 'Call', allDay: false, start: '2026-10-25T11:00:00Z', end: '2026-10-25T11:00:00Z' })
  assert.equal(created.id, 'newtask')
  assert.equal(task.projectId, 'personal')
  delete task.startDate
  const [point] = await client.items(source, day.start, day.end)
  const moved = await client.update(source, point, { ...point, start: '2026-10-25T12:00:00Z', end: '2026-10-25T12:00:00Z' })
  assert.equal(moved.start, moved.end)
  assert.equal(task.startDate, undefined)
  assert.equal(task.dueDate, '2026-10-25T13:00:00+0100')
})

test('never retries an unconfirmed write or infers a created task ID from its title', async () => {
  const draft = { title: original.title, allDay: true, ...day }
  for (const result of [
    () => response(null, 201), () => response({ title: draft.title }), () => response(null, 503),
    () => { throw new Error('timeout') }, () => new Response('truncated JSON'),
  ]) {
    const { client, calls } = api(result)
    await assert.rejects(client.create(source, draft), { code: 'UNCERTAIN' })
    assert.deepEqual(calls.map(call => [call.method, call.path]), [['POST', '/task']])
  }
  const { client } = api(() => response(null, 403))
  await assert.rejects(client.create(source, draft), error => error.code !== 'UNCERTAIN' && /denied/.test(error.message))
})

test('does not confirm completion from a missing task or silently accept lost checklist data', async () => {
  let sent = false
  const { client } = api(({ path, method }) => {
    if (path.endsWith('/data')) return response({ tasks: [original] })
    if (method === 'GET') return sent ? response(null, 404) : response(original)
    sent = true
    return path.endsWith('/complete') ? response(null) : response({ ...original, items: [] })
  })
  const [item] = await client.items(source, day.start, day.end)
  await assert.rejects(client.complete(source, item), { code: 'UNCERTAIN' })
  sent = false
  await assert.rejects(client.update(source, item, { ...day, allDay: true }), { code: 'UNCERTAIN' })
})

test('an expired or rejected grant asks for sign-in before another task change', async () => {
  const expired = createTickTick({ token: 'old', expiresAt: Date.now() - 1000, fetchImpl: () => assert.fail('Used an expired grant') })
  await assert.rejects(expired.sources(), { code: 'AUTH_REQUIRED' })
  const rejected = createTickTick({ token: 'revoked', fetchImpl: async () => new Response(null, { status: 401 }) })
  await assert.rejects(rejected.sources(), { code: 'AUTH_REQUIRED', status: 401 })
})
