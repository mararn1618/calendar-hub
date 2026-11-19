import assert from 'node:assert/strict'
import test from 'node:test'
import { createTickTick } from '../desktop/providers/ticktick.mjs'
import { CalendarService } from '../desktop/calendar-service.mjs'

const source = { id: 'personal', name: 'Personal', writable: true }
const inbox = { id: 'inbox', name: 'Inbox', writable: true }
const zone = 'Europe/Berlin'
const day = { start: '2026-10-25', end: '2026-10-26' }
const original = {
  id: 'task1', projectId: source.id, title: 'Buy apples', status: 0,
  timeZone: zone, isAllDay: true, dueDate: '2026-10-24T22:00:00+0000',
  content: 'Six apples', desc: 'Market list', tags: ['market'], reminders: ['TRIGGER:PT0S'],
  priority: 3, sortOrder: -91, parentId: 'parent', items: [{ id: 'apple', title: 'Apples', status: 1, sortOrder: 1 }],
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
  projects[199].groupId = 'work'
  const { client, calls } = api(({ path, query }) => {
    if (path === '/project/group') return response([{ id: 'work', name: 'Work', sortOrder: 0 }])
    assert.equal(path, '/project')
    assert.equal(query.get('limit'), '200')
    return response(query.get('offset') === '0' ? projects : [
      { id: 'shared', name: 'Shared', permission: 'comment' }, { id: 'read', name: 'Read', permission: 'read' },
      { id: 'old', name: 'Old', groupId: 'work', closed: true }, { id: 'notes', name: 'Notes', kind: 'NOTE' },
    ])
  })
  const lists = await client.sources()
  assert.deepEqual(calls.map(call => [call.path, call.query.get('offset')]), [
    ['/project', '0'], ['/project', '200'], ['/project/group', null],
  ])
  assert.deepEqual(lists[0], { ...inbox, groupId: null, sortOrder: null, archived: false, inbox: true })
  const last = lists.find(p => p.id === 'p199')
  const archived = lists.find(p => p.id === 'old')
  assert(last.writable)
  assert.equal(last.archived, false)
  assert.equal(archived.archived, true)
  assert.deepEqual(last.folder, { id: 'work', name: 'Work', sortOrder: '0' })
  assert.deepEqual(archived.folder, last.folder)
  assert(lists.filter(p => ['read', 'shared', 'old'].includes(p.id)).every(p => !p.writable))
  assert(!lists.find(p => p.id === 'notes'))
})

test('keeps exact signed list and folder orders, and updates names, moves and provider order on refresh', async () => {
  let projects = `[
    {"id":"second","name":"Second","groupId":"g1","sortOrder":-9223372036854775807,"color":"#468ace"},
    {"id":"first","name":"First","groupId":"g2","sortOrder":-9223372036854775808},
    {"id":"inbox47","name":"Eingang"},
    {"id":"root","name":"Root","sortOrder":"9007199254740993"}
  ]`
  let groups = `[
    {"id":"g1","name":"🌱 Garten","sortOrder":9223372036854775807},
    {"id":"g2","name":"Garten","sortOrder":9223372036854775806}
  ]`
  const { client } = api(({ path }) => new Response(path === '/project' ? projects : groups))
  const first = await client.sources()
  assert.deepEqual(first.map(p => p.id), ['inbox47', 'second', 'first', 'root'])
  assert.deepEqual(first.map(p => p.sortOrder), [null, '-9223372036854775807', '-9223372036854775808', '9007199254740993'])
  assert.equal(first[0].inbox, true)
  assert.equal(first[0].name, 'Eingang')
  assert.equal(first[1].color, '#468ace')
  assert.deepEqual(first[1].folder, { id: 'g1', name: '🌱 Garten', sortOrder: '9223372036854775807' })
  assert.deepEqual(first[2].folder, { id: 'g2', name: 'Garten', sortOrder: '9223372036854775806' })
  assert.equal(first[3].groupId, null)
  assert(!Object.hasOwn(first[3], 'folder'))

  projects = `[
    {"id":"root","name":"Root"},
    {"id":"first","name":"First","groupId":"","sortOrder":100.5},
    {"id":"second","name":"Second","groupId":"g2","sortOrder":9223372036854775808},
    {"id":"inbox47","name":"Eingang"}
  ]`
  groups = '[{"id":"g2","name":"Familie","sortOrder":"-5"}]'
  const refreshed = await client.sources()
  assert.deepEqual(refreshed.map(p => p.id), ['inbox47', 'root', 'first', 'second'])
  assert.deepEqual(refreshed.map(p => p.sortOrder), [null, null, null, null])
  assert.equal(refreshed[2].groupId, null)
  assert(!Object.hasOwn(refreshed[2], 'folder'))
  assert.equal(refreshed[3].groupId, 'g2')
  assert.deepEqual(refreshed[3].folder, { id: 'g2', name: 'Familie', sortOrder: '-5' })
})

test('keeps grouped lists readable when folder metadata is missing or inaccessible', async () => {
  const projects = [
    { ...source, groupId: 'group' }, { id: 'other', name: 'Other', groupId: 'group2' },
  ]
  let folderReply
  const { client } = api(({ path }) => {
    if (path === '/project') return response(projects)
    if (path === '/project/group') return folderReply()
    assert.equal(path, '/project/personal/data')
    return response({ tasks: [original] })
  })
  for (folderReply of [
    () => response(null, 403), () => response(null, 404), () => response(null, 503),
    () => { throw new Error('offline') }, () => new Response('broken JSON'),
    () => response({ groups: [] }), () => response([]), () => response([{ id: 'group', name: '  ' }]),
    () => response([{ id: 'group', name: 'Work' }, { id: 'group', name: 'Home' }]),
  ]) {
    const [, list] = await client.sources()
    assert.equal(list.groupId, 'group')
    assert(!Object.hasOwn(list, 'folder'))
    assert.equal((await client.items(list, day.start, day.end))[0].canEdit, true)
  }
  folderReply = () => response([null, { id: 'group2', name: {} }, { id: 'group', name: 'Home' }])
  const [, home, other] = await client.sources()
  assert.deepEqual(home.folder, { id: 'group', name: 'Home', sortOrder: null })
  assert.equal(other.groupId, 'group2')
  assert(!Object.hasOwn(other, 'folder'))
  folderReply = () => response(null, 401)
  await assert.rejects(client.sources(), { code: 'AUTH_REQUIRED', status: 401 })
})

test('rejects an incomplete project refresh before loading its folders', async () => {
  const projects = Array.from({ length: 200 }, (_, i) => ({ id: 'p' + i, name: 'List ' + i, groupId: 'work' }))
  const { client, calls } = api(({ query }) => response(query.get('offset') === '0' ? projects : [projects[0]]))
  await assert.rejects(client.sources(), /repeated a list/)
  assert.deepEqual(calls.map(call => call.path), ['/project', '/project'])
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

test('account identity uses a published private Inbox or queries only that local day', async () => {
  const published = api(({ path }) => {
    assert.equal(path, '/project')
    return response([{ id: 'inbox47', name: 'Inbox' }])
  })
  await published.client.sources()
  assert.equal(await published.client.accountInboxId(day.start), 'inbox47')
  assert.equal(published.calls.length, 1)

  const account = api(({ path, body }) => {
    if (path === '/project') return response([inbox, source])
    assert.equal(path, '/task/undone')
    assert.deepEqual(body.projectIds, ['inbox'])
    assert.equal(body.startDate, '2026-10-25T00:00:00+0200')
    assert.equal(body.endDate, '2026-10-25T23:59:59.999+0100')
    return response([{ ...original, projectId: 'inbox84' }])
  })
  await account.client.sources()
  assert.deepEqual(account.calls.map(call => call.path), ['/project'])
  assert.equal(await account.client.accountInboxId(day.start), 'inbox84')
  assert.equal(await account.client.accountInboxId(day.end), 'inbox84')
  assert.deepEqual(account.calls.map(call => call.path), ['/project', '/task/undone'])
})

test('an empty Inbox or an alias does not identify an account, and conflicting IDs are never cached', async () => {
  let tasks = [{ ...original, projectId: 'inbox1' }, { ...original, projectId: 'inbox2' }]
  const { client } = api(({ path }) => {
    assert.equal(path, '/task/undone')
    return response(tasks)
  })
  await assert.rejects(client.accountInboxId(day.start), /different Inbox identifiers/)
  tasks = []
  assert.equal(await client.accountInboxId(day.start), undefined)
  tasks = [{ ...original, projectId: 'inbox' }]
  assert.equal(await client.accountInboxId(day.start), undefined)
})

test('a new grant can verify a previously recorded private Inbox by its exact project ID', async () => {
  const { client, calls } = api(({ method, path }) => {
    assert.equal(method, 'GET')
    assert.equal(path, '/project/inbox47')
    return response({ id: 'inbox47', name: 'Eingang' })
  })
  assert.equal(await client.accountInboxId(day.start, 'inbox47'), 'inbox47')
  assert.equal(await client.accountInboxId(day.end), 'inbox47')
  assert.equal(calls.length, 1)
})

test('an unverified private project falls back to the current grant’s Inbox', async () => {
  for (const project of [response(null, 404), response(null, 403), response(null), response({ tasks: [] }),
    response({ id: 'inbox' }), response({ id: 'inbox84' })]) {
    const { client, calls } = api(({ path, body }) => {
      if (path === '/project/inbox47') return project
      assert.equal(path, '/task/undone')
      assert.deepEqual(body.projectIds, ['inbox'])
      return response([])
    })
    assert.equal(await client.accountInboxId(day.start, 'inbox47'), undefined)
    assert.deepEqual(calls.map(call => call.path), ['/project/inbox47', '/task/undone'])
  }
  const rejected = api(() => response(null, 401))
  await assert.rejects(rejected.client.accountInboxId(day.start, 'inbox47'), { code: 'AUTH_REQUIRED' })
  assert.equal(rejected.calls.length, 1)
})

test('the actual Inbox identifies a different account even when a saved ID was supplied', async () => {
  const account = api(({ path }) => path === '/project/inbox47' ? response(null, 404) : response([{ ...original, projectId: 'inbox84' }]))
  assert.equal(await account.client.accountInboxId(day.start, 'inbox47'), 'inbox84')
  assert.equal(await account.client.accountInboxId(day.end, 'inbox47'), 'inbox84')
  assert.deepEqual(account.calls.map(call => call.path), ['/project/inbox47', '/task/undone'])
  const alias = api(({ path }) => {
    assert.equal(path, '/task/undone')
    return response([])
  })
  assert.equal(await alias.client.accountInboxId(day.start, 'inbox'), undefined)
})

test('uses the published Inbox project ID for creation or verifies the alias by ID within Inbox', async () => {
  const draft = { title: 'Follow up', allDay: true, ...day }
  const published = api(({ path, body }) => {
    if (path === '/project') return response([source, inbox, { id: 'inbox123', name: 'Eingang' }])
    assert.equal(path, '/task')
    assert.equal(body.projectId, 'inbox123')
    return response({ ...body, id: 'published' })
  })
  const lists = await published.client.sources()
  assert.deepEqual(lists.map(list => list.id), ['inbox123', source.id])
  assert.equal((await published.client.create(lists[0], draft)).id, 'published')
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
  for (const key of ['id', 'projectId', 'title', 'content', 'desc', 'items', 'tags', 'priority', 'sortOrder', 'parentId', 'reminders']) {
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

test('a stale list version rejects the drag and returns the checked task without another list scan', async () => {
  const summary = { ...original, etag: 'from-list' }
  let detail = { ...original, title: 'Updated in TickTick', etag: 'from-detail' }
  const { client, calls } = api(({ path, method, body }) => {
    if (path === '/project') return response([source])
    if (path === '/task/undone') return response([])
    if (path.endsWith('/data')) return response({ tasks: [summary] })
    if (method === 'GET') return response(detail)
    detail = { ...body, etag: 'saved' }
    return response(detail)
  })
  const profile = { data: { connections: [], sources: [], cache: {}, hidden: [], journal: [] },
    open: () => ({}), seal: () => null, save() {} }
  const service = new CalendarService(profile, { authorize: async () => ({}), identity: () => 'personal', client: () => client })
  await service.run('connect', { provider: 'ticktick' })
  const [item] = (await service.run('state', day)).items
  calls.length = 0
  const move = { start: '2026-10-25T11:00:00Z', end: '2026-10-25T12:00:00Z', allDay: false }
  await assert.rejects(service.run('save', { ...item, ...move }), { code: 'CONFLICT' })
  assert.deepEqual(calls.map(call => [call.method, call.path]), [['GET', '/project/personal/task/task1']])
  const latest = (await service.run('state', { ...day, cachedOnly: true })).items[0]
  assert.equal(latest.title, detail.title)
  assert.notEqual(latest.version, item.version)
  await assert.rejects(service.run('save', { ...item, ...move }), { code: 'CONFLICT' })
  assert.equal(calls.length, 1)
  const { item: confirmed } = await service.run('save', { ...latest, ...move, viewRange: day })
  assert.deepEqual(calls.slice(1).map(call => [call.method, call.path]), [
    ['GET', '/project/personal/task/task1'], ['POST', '/task/task1'],
  ])
  assert.equal(confirmed.start, '2026-10-25T11:00:00.000Z')
  assert.equal(confirmed.title, 'Updated in TickTick')
  assert.equal(detail.content, original.content)
  assert.deepEqual(detail.items, original.items)
})

test('a throttled detail read reports a request limit and sends no write', async () => {
  const { client, calls } = api(({ path }) => path.endsWith('/data') ? response({ tasks: [original] }) : response(null, 429))
  const [item] = await client.items(source, day.start, day.end)
  await assert.rejects(client.update(source, item, item), { code: 'RATE_LIMITED', status: 429 })
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET'])
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
