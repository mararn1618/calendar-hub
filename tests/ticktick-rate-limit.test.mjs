import assert from 'node:assert/strict'
import test from 'node:test'
import { createTickTick, recordTickTickRateLimit, tickTickCooldown } from '../desktop/providers/ticktick.mjs'

const origin = Date.parse('2026-11-19T12:00:00Z')
const list = { id: 'private-project', writable: true }
const draft = { title: 'Private task', allDay: true, start: '2026-11-19', end: '2026-11-20' }

function json(value) {
  return Response.json(value)
}

function throttle(retryAfter) {
  return new Response(null, { status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } })
}

function fixture(handle, options = {}) {
  const calls = []
  const client = createTickTick({
    token: 'private-token', apiBase: 'https://example.invalid', timeZone: 'UTC', ...options,
    fetchImpl: (url, { method }) => {
      const path = new URL(url).pathname
      calls.push([method, path])
      return handle(path, method)
    },
  })
  return { client, calls }
}

test('Retry-After accepts delta seconds and HTTP dates, preserving provider delays longer than the fallback cap', () => {
  for (const [header, seconds] of [
    ['007', 7], ['7200', 7200], ['0', 60], ['Thu, 19 Nov 2026 12:01:40 GMT', 100],
    ['Thursday, 19-Nov-26 12:01:40 GMT', 100], ['Thu Nov 19 12:01:40 2026', 100],
    ['Thu, 19 Nov 2026 11:59:00 GMT', 60], ['Thu 19 Nov 2040 GMT', 60],
    [undefined, 60], ['', 60], ['2.5', 60], ['-1', 60], ['wrong', 60],
  ]) {
    const state = {}
    const error = recordTickTickRateLimit(state, header, origin)
    assert.equal(error.code, 'RATE_LIMITED')
    assert.equal(error.status, 429)
    assert.equal(error.retryAt, origin + seconds * 1000)
    assert.equal(tickTickCooldown(state, error.retryAt - 1).retryAt, error.retryAt)
    assert.equal(tickTickCooldown(state, error.retryAt), undefined)
  }
})

test('repeated 429s with immediate or past deadlines progressively delay all new reads', async () => {
  let now = origin
  const { client, calls } = fixture(() => now === origin ? throttle('0') : throttle(new Date(origin).toUTCString()), { now: () => now })
  for (const delay of [60_000, 120_000, 240_000]) {
    const retryAt = now + delay
    await assert.rejects(client.sources(), { code: 'RATE_LIMITED', retryAt })
    now = retryAt - 1
    await assert.rejects(client.sources(), { code: 'RATE_LIMITED', retryAt })
    now = retryAt
  }
  assert.equal(calls.length, 3)
})

test('a folder 429 blocks metadata, tasks, identity checks and mutations for just that account across client restarts', async () => {
  let now = origin
  let foldersLimited = true
  const saved = []
  const rateLimit = {}, requestStats = {}
  const options = { rateLimit, requestStats, now: () => now, onRateLimitChange: () => saved.push(structuredClone(rateLimit)) }
  const handle = path => {
    if (path === '/project') return json([{ ...list, name: 'Private list', groupId: 'private-folder' }])
    if (path === '/project/group') return foldersLimited ? throttle('120') : json([])
    assert.fail('Unexpected request ' + path)
  }
  const { client, calls } = fixture(handle, options)
  const expected = { code: 'RATE_LIMITED', status: 429, retryAt: origin + 120_000 }
  await assert.rejects(client.sources(), expected)
  const original = { ...draft, id: 'private-task', _ticktick: { projectId: list.id } }
  const readsAndWrites = [
    client.sources(), client.items(list, draft.start, draft.end), client.itemsForSources([list], draft.start, draft.end),
    client.accountInboxId(draft.start, 'private-inbox'), client.create(list, draft), client.update(list, original, draft), client.complete(list, original),
  ]
  await Promise.all(readsAndWrites.map(request => assert.rejects(request, expected)))
  assert.deepEqual(calls, [['GET', '/project'], ['GET', '/project/group']])
  assert.deepEqual(saved, [{ attempts: 1, retryAt: expected.retryAt, endpoint: 'folders' }])
  const restored = fixture(handle, { ...options, rateLimit: structuredClone(saved[0]) })
  now = expected.retryAt - 1
  await assert.rejects(restored.client.sources(), expected)
  assert.equal(restored.calls.length, 0)
  const otherAccount = fixture(() => json([]), { now: () => now })
  await otherAccount.client.sources()
  assert.equal(otherAccount.calls.length, 1)
  assert.deepEqual(requestStats, {
    lists: { count: 1, lastAt: origin, lastStatus: 200 },
    folders: { count: 1, lastAt: origin, lastStatus: 429, lastLimitedAt: origin, lastRetryAt: expected.retryAt },
  })
  foldersLimited = false
  now = expected.retryAt
  await client.sources()
  assert.deepEqual(saved.at(-1), {})
  assert.deepEqual(rateLimit, {})
  assert.equal(requestStats.folders.count, 2)
  assert.equal(requestStats.folders.lastStatus, 200)
  assert(!JSON.stringify(requestStats).includes('private'))
})

test('a successful directory page does not reset repeated folder 429s, and a successful folder read starts the next backoff at one minute', async () => {
  let now = origin
  let recovering = false
  const rateLimit = {}
  const { client, calls } = fixture(path => path === '/project'
    ? json([{ ...list, name: 'Private list', groupId: 'private-folder' }]) : recovering ? json([]) : throttle('invalid'), {
    rateLimit, now: () => now,
  })
  for (const minutes of [1, 2, 4, 8, 16, 32, 60, 60]) {
    const retryAt = now + minutes * 60_000
    await assert.rejects(client.sources(), { code: 'RATE_LIMITED', retryAt })
    now = retryAt
  }
  assert.equal(calls.length, 16)
  recovering = true
  await client.sources()
  assert.deepEqual(rateLimit, {})
  recovering = false
  await assert.rejects(client.sources(), { code: 'RATE_LIMITED', retryAt: now + 60_000 })
})

test('a 429 on a targeted Inbox identity lookup stops its fallback read', async () => {
  const { client, calls } = fixture(() => throttle('Thu, 19 Nov 2026 12:05:01 GMT'), { now: () => origin })
  await assert.rejects(client.accountInboxId(draft.start, 'inbox21'), { code: 'RATE_LIMITED', retryAt: origin + 301_000 })
  assert.deepEqual(calls, [['GET', '/project/inbox21']])
})

test('a late success cannot clear a newer 429 or shorten the longest delay requested by concurrent responses', async () => {
  const late = Promise.withResolvers(), short = Promise.withResolvers()
  const rateLimit = {}
  const { client, calls } = fixture(path => {
    if (path === '/project') return late.promise
    if (path === '/task/undone') return short.promise
    return throttle('180')
  }, { rateLimit, now: () => origin })
  const pendingLists = client.sources()
  const pendingRange = client.itemsForSources([list], draft.start, draft.end)
  await assert.rejects(client.items(list, draft.start, draft.end), { code: 'RATE_LIMITED', retryAt: origin + 180_000 })
  late.resolve(json([]))
  await pendingLists
  short.resolve(throttle('10'))
  await assert.rejects(pendingRange, { code: 'RATE_LIMITED', retryAt: origin + 180_000 })
  await assert.rejects(client.sources(), { code: 'RATE_LIMITED', retryAt: origin + 180_000 })
  assert.equal(calls.length, 3)
  assert.equal(rateLimit.attempts, 1)
})

test('a rejected mutation and an accepted write whose confirmation is throttled are each sent only once', async () => {
  const rejected = fixture(() => throttle('90'), { now: () => origin })
  const limit = { code: 'RATE_LIMITED', retryAt: origin + 90_000 }
  await assert.rejects(rejected.client.create(list, draft), limit)
  await assert.rejects(rejected.client.create(list, draft), limit)
  assert.deepEqual(rejected.calls, [['POST', '/task']])

  let now = origin
  const { client, calls } = fixture((path, method) => {
    if (method === 'POST' && path === '/task') return json({ id: 'private-task' })
    if (path === '/project') return json([])
    return throttle('90')
  }, { now: () => now })
  await assert.rejects(client.create(list, draft), { code: 'UNCERTAIN', providerId: 'private-task', retryAt: limit.retryAt })
  await assert.rejects(client.create(list, draft), limit)
  now = limit.retryAt
  await client.sources()
  assert.deepEqual(calls, [['POST', '/task'], ['GET', '/project/private-project/task/private-task'], ['GET', '/project']])
})

test('a confirmed write stays confirmed if saving the cleared cooldown fails', async () => {
  const rateLimit = { retryAt: origin, attempts: 1, endpoint: 'createTask' }
  const { client, calls } = fixture(() => json({
    id: 'created', projectId: list.id, title: draft.title, isAllDay: true, timeZone: 'UTC',
    startDate: '2026-11-19T00:00:00+0000', dueDate: '2026-11-19T00:00:00+0000',
  }), { rateLimit, now: () => origin, onRateLimitChange: () => { throw new Error('Storage unavailable') } })
  assert.equal((await client.create(list, draft)).id, 'created')
  assert.deepEqual(rateLimit, {})
  assert.deepEqual(calls, [['POST', '/task']])
})
