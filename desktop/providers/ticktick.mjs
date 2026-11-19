import { createHash } from 'node:crypto'

const DAY = 86_400_000
const CIVIL = /^\d{4}-\d{2}-\d{2}$/
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i
const TASK_FIELDS = [
  'content', 'desc', 'items', 'reminders', 'tags', 'priority', 'sortOrder', 'kind',
  'parentId', 'columnId', 'assigneeUsername', 'repeatFlag', 'repeatFrom',
]
const SCHEDULE_FIELDS = ['isAllDay', 'startDate', 'dueDate', 'timeZone']
const dateFormatters = new Map()

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function id(value) {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..' || /[\u0000-\u001f]/.test(value)) {
    throw new Error('TickTick returned an invalid identifier.')
  }
  return value
}

function failure(message, code, status) {
  return Object.assign(new Error(message), { code, status })
}

function parseProjectMetadata(text) {
  return JSON.parse(text, (key, value, context) => {
    if (key !== 'sortOrder') return value
    const raw = typeof value === 'number' ? context.source : value
    if (typeof raw !== 'string' || !/^-?\d{1,19}$/.test(raw)) return null
    const order = BigInt(raw)
    return BigInt.asIntN(64, order) === order ? String(order) : null
  })
}

function conflict() {
  return failure('This task changed in TickTick. Refresh it before editing.', 'CONFLICT')
}

function civil(day) {
  if (typeof day !== 'string' || !CIVIL.test(day)) throw new Error('Enter a valid calendar date.')
  const value = Date.parse(day + 'T00:00:00Z')
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== day) {
    throw new Error('Enter a valid calendar date.')
  }
  return value
}

function shiftDay(day, days) {
  return new Date(civil(day) + days * DAY).toISOString().slice(0, 10)
}

function offsetAt(epoch, zone) {
  let formatter = dateFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' })
    dateFormatters.set(zone, formatter)
  }
  const name = formatter.formatToParts(epoch).find(part => part.type === 'timeZoneName').value
  if (name === 'GMT') return 0
  const [, sign, hours, minutes, seconds] = /^GMT([+-])(\d\d):(\d\d)(?::(\d\d))?$/.exec(name)
  return (sign === '-' ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds || 0)) * 1000
}

function localIso(epoch, zone) {
  return new Date(epoch + offsetAt(epoch, zone)).toISOString()
}

function instant(input, zone) {
  if (input instanceof Date && Number.isFinite(input.getTime())) return input.getTime()
  if (typeof input !== 'string') throw new Error('Enter a valid task date and time.')
  const stamp = CIVIL.test(input) ? input + 'T00:00' : input
  const parts = STAMP.exec(stamp)
  if (!parts) throw new Error('Enter a valid task date and time.')
  const [, day, hour, minute, second = '00', fraction = '', offset] = parts
  civil(day)
  if (+hour > 23 || +minute > 59 || +second > 59) throw new Error('Enter a valid task time.')
  const clock = day + 'T' + hour + ':' + minute + ':' + second + fraction
  if (offset) {
    const epoch = Date.parse(clock + offset.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))
    if (Number.isFinite(epoch)) return epoch
    throw new Error('Enter a valid time zone offset.')
  }
  const wallClock = Date.parse(clock + 'Z')
  const offsets = [...new Set([offsetAt(wallClock - DAY, zone), offsetAt(wallClock + DAY, zone)])].sort((a, b) => b - a)
  for (const offsetMs of offsets) {
    const epoch = wallClock - offsetMs
    if (offsetAt(epoch, zone) === offsetMs) return epoch
  }
  if (CIVIL.test(input)) {
    const first = offsets.map(offset => wallClock - offset).find(epoch => localIso(epoch, zone).slice(0, 10) === day)
    if (first !== undefined) return first
  }
  throw new Error('This local time does not exist in ' + zone + '.')
}

function dayOf(input, zone) {
  if (CIVIL.test(input)) {
    civil(input)
    return input
  }
  return localIso(instant(input, zone), zone).slice(0, 10)
}

function apiTime(epoch, zone) {
  const minutes = Math.trunc(offsetAt(epoch, zone) / 60_000)
  const absolute = Math.abs(minutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const rest = String(absolute % 60).padStart(2, '0')
  return localIso(epoch, zone).replace(/(?:\.000)?Z$/, '') + (minutes < 0 ? '-' : '+') + hours + rest
}

function stable(value) {
  return JSON.stringify(value, (_key, part) => object(part)
    ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]]))
    : part)
}

function pick(row, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))
}

function schedule(task, zone) {
  const first = task.startDate || task.dueDate
  if (!first) return null
  const last = task.dueDate || first
  const allDay = task.isAllDay === true || (CIVIL.test(first) && CIVIL.test(last))
  if (allDay) {
    const taskZone = task.timeZone || zone
    const start = dayOf(first, taskZone)
    const lastDay = dayOf(last, taskZone)
    if (lastDay < start) throw new Error('TickTick returned a task ending before it starts.')
    return { allDay, start, end: shiftDay(lastDay, 1) }
  }
  const start = instant(first, task.timeZone || zone)
  const end = instant(last, task.timeZone || zone)
  if (end < start) throw new Error('TickTick returned a task ending before it starts.')
  return { allDay, start: new Date(start).toISOString(), end: new Date(end).toISOString() }
}

function version(task, dates, fields) {
  const snapshot = [task.id, task.title, task.status ?? 0, !!task.repeatFlag, dates, pick(task, fields)]
  return createHash('sha256').update(stable(snapshot)).digest('base64url')
}

function isInbox(source) {
  return source.id === 'inbox' || source.inbox === true
}

function normalize(source, task, zone) {
  id(task.id)
  if (typeof task.title !== 'string') throw new Error('TickTick returned a task without a title.')
  const projectId = id(task.projectId || source.id)
  if (!isInbox(source) && projectId !== source.id) throw new Error('TickTick returned a task from another list.')
  const dates = schedule(task, zone)
  if (!dates) return null
  const recurring = !!task.repeatFlag
  const completed = task.status === 2
  const canEdit = source.writable && !recurring && (task.status ?? 0) === 0
  const fields = Object.keys(pick(task, [...TASK_FIELDS, 'timeZone', 'etag', 'modifiedTime']))
  return {
    id: task.id, title: task.title, ...dates, completed, recurring,
    canEdit, canComplete: canEdit, canDelete: false, hasAttendees: false,
    version: version(task, dates, fields),
    _ticktick: { projectId, fields },
  }
}

function overlaps(item, start, end, zone) {
  const first = instant(item.start, zone)
  const last = instant(item.end, zone)
  return first < end && (first === last ? first >= start : last > start)
}

function writable(source) {
  id(source.id)
  if (!source.writable) throw new Error('This TickTick list is read-only.')
}

function taskPath(project, task) {
  return '/project/' + encodeURIComponent(id(project)) + '/task/' + encodeURIComponent(id(task))
}

function draftFields(draft, zone, original) {
  const title = draft.title ?? original?.title
  if (typeof title !== 'string' || !title.trim()) throw new Error('Enter a task title.')
  if (typeof draft.allDay !== 'boolean') throw new Error('Choose a timed or all-day task.')
  let end
  if (draft.allDay) {
    civil(draft.start)
    end = shiftDay(draft.end, -1)
    if (end < draft.start) throw new Error('The all-day end must follow the start date.')
  } else {
    end = draft.end ?? draft.start
  }
  const startMs = instant(draft.start, zone)
  const endMs = instant(end, zone)
  if (endMs < startMs) throw new Error('The task ends before it starts.')
  const fields = {
    title, isAllDay: draft.allDay, timeZone: zone,
    startDate: apiTime(startMs, zone), dueDate: apiTime(endMs, zone),
  }
  if (original) {
    if (stable(schedule(original, zone)) === stable(schedule(fields, zone))) {
      return { title, ...pick(original, SCHEDULE_FIELDS) }
    }
    if (startMs === endMs) {
      if (!original.startDate && original.dueDate) delete fields.startDate
      if (original.startDate && !original.dueDate) delete fields.dueDate
    }
  }
  return fields
}

export function createTickTick({
  token, expiresAt, apiBase = 'https://api.ticktick.com/open/v1', fetchImpl = fetch,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('Enter a TickTick API token.')
  }
  const base = apiBase.replace(/\/+$/, '')
  let inboxProjectId

  async function request(path, { method = 'GET', body, write = false, parse = JSON.parse } = {}) {
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      throw failure('TickTick sign-in expired. Choose Reconnect in Calendars.', 'AUTH_REQUIRED')
    }
    let response
    try {
      response = await fetchImpl(base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: 'Bearer ' + token.trim(), Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      if (write) throw failure('The connection ended before TickTick confirmed the change. Check TickTick before trying again.', 'UNCERTAIN')
      throw new Error('Could not reach TickTick. Check your connection and refresh.')
    }
    if (!response.ok) {
      const status = response.status
      await response.body?.cancel().catch(() => {})
      if (status === 409 || status === 412) throw conflict()
      if (write && (status >= 500 || status === 408)) {
        throw failure('TickTick did not confirm the change (HTTP ' + status + '). Check the original task.', 'UNCERTAIN', status)
      }
      const message = status === 401 ? 'TickTick did not accept this sign-in. Reconnect in Calendars or use a personal API token.' :
        status === 403 ? 'TickTick denied access to this list or action.' :
        'TickTick returned HTTP ' + status + '.'
      throw failure(message, status === 401 ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR', status)
    }
    if (write && ![200, 201, 204].includes(response.status)) {
      await response.body?.cancel().catch(() => {})
      throw failure('TickTick has not confirmed the change (HTTP ' + response.status + '). Check the original task.', 'UNCERTAIN', response.status)
    }
    try {
      const text = await response.text()
      return text.trim() ? parse(text) : null
    } catch {
      if (write) throw failure('TickTick sent an unreadable reply. Check the original task before trying again.', 'UNCERTAIN')
      throw new Error('TickTick sent an unreadable reply. Refresh this list.')
    }
  }

  async function projectFolders() {
    const folders = new Map()
    let groups
    try {
      groups = await request('/project/group', { parse: parseProjectMetadata })
    } catch (error) {
      if (error.code === 'AUTH_REQUIRED') throw error
      return folders
    }
    if (!Array.isArray(groups)) return folders
    for (const group of groups) {
      if (typeof group?.id !== 'string') continue
      const usable = !folders.has(group.id) && typeof group.name === 'string' && group.name.trim()
      folders.set(group.id, usable ? { id: group.id, name: group.name, sortOrder: group.sortOrder ?? null } : null)
    }
    return folders
  }

  async function sources() {
    const lists = []
    const seen = new Set()
    const limit = 200
    let inboxList
    for (let offset = 0; ; offset += limit) {
      const page = await request('/project?offset=' + offset + '&limit=' + limit, { parse: parseProjectMetadata })
      if (!Array.isArray(page) || page.length > limit) throw new Error('TickTick returned an invalid list page.')
      for (const project of page) {
        if (!object(project)) throw new Error('TickTick returned an invalid list.')
        id(project.id)
        if (seen.has(project.id)) throw new Error('TickTick repeated a list while loading the next page. Refresh the lists.')
        seen.add(project.id)
        if (typeof project.name !== 'string') throw new Error('TickTick returned a list without a name.')
        if (project.kind?.toUpperCase() === 'NOTE') continue
        const inbox = project.id === inboxProjectId || /^inbox(?:\d+)?$/.test(project.id)
        const groupId = inbox || project.groupId == null || project.groupId === '' ? null : id(project.groupId)
        const archived = Boolean(project.closed)
        const list = {
          id: project.id, name: project.name, color: project.color,
          writable: !archived && (project.permission == null || project.permission === 'write'),
          groupId, sortOrder: project.sortOrder ?? null, archived, inbox,
        }
        if (!inbox) lists.push(list)
        else if (!inboxList || inboxList.id === 'inbox') inboxList = list
        else if (project.id !== 'inbox') throw new Error('TickTick returned different Inbox identifiers.')
      }
      if (page.length < limit) break
    }
    if (lists.some(list => list.groupId !== null)) {
      const folders = await projectFolders()
      for (const list of lists) {
        const folder = folders.get(list.groupId)
        if (folder) list.folder = folder
      }
    }
    if (inboxList && inboxList.id !== 'inbox') inboxProjectId = inboxList.id
    return [inboxList ?? {
      id: 'inbox', name: 'Inbox', writable: true, groupId: null, sortOrder: null, archived: false, inbox: true,
    }, ...lists]
  }

  async function inboxTasks(start, end, taskIds) {
    const tasks = []
    for (let cursor = start; cursor < end;) {
      const lastDay = shiftDay(localIso(cursor, timeZone).slice(0, 10), 14)
      const next = Math.min(end, cursor + 14 * DAY, instant(lastDay, timeZone))
      const body = { projectIds: ['inbox'], startDate: apiTime(cursor, timeZone), endDate: apiTime(next - 1, timeZone) }
      if (taskIds) body.taskIds = taskIds
      const page = await request('/task/undone', { method: 'POST', body })
      if (!Array.isArray(page)) throw new Error('TickTick returned an invalid Inbox response.')
      for (const task of page) {
        if (!object(task)) throw new Error('TickTick returned an invalid Inbox task.')
        if (task.projectId && task.projectId !== 'inbox') {
          if (inboxProjectId && task.projectId !== inboxProjectId) throw new Error('TickTick returned different Inbox identifiers.')
          inboxProjectId = id(task.projectId)
        }
        tasks.push(task)
      }
      cursor = next
    }
    return tasks
  }

  async function items(source, start, end) {
    const from = instant(start, timeZone)
    const until = instant(end, timeZone)
    if (from >= until) throw new Error('The calendar range must end after it starts.')
    let rows
    if (isInbox(source)) {
      rows = await inboxTasks(from, until)
    } else {
      const data = await request('/project/' + encodeURIComponent(id(source.id)) + '/data')
      if (!Array.isArray(data?.tasks) || (data.project?.id && data.project.id !== source.id)) {
        throw new Error('TickTick returned an invalid task list.')
      }
      rows = data.tasks
    }
    const result = new Map()
    for (const row of rows) {
      if (!object(row)) throw new Error('TickTick returned an invalid task.')
      if ((row.status ?? 0) !== 0 || row.kind === 'NOTE') continue
      const item = normalize(source, row, timeZone)
      if (item && overlaps(item, from, until, timeZone)) result.set(item.id, item)
    }
    return [...result.values()]
  }

  async function readTask(source, project, taskId) {
    const task = await request(taskPath(project, taskId))
    if (task?.id !== taskId || (task.projectId && task.projectId !== project && !(isInbox(source) && project === 'inbox'))) {
      throw new Error('TickTick returned a different task.')
    }
    return task.projectId ? task : { ...task, projectId: project }
  }

  async function current(source, original) {
    writable(source)
    if (original.recurring) throw new Error('Change repeating tasks in TickTick. Its API cannot target a single occurrence.')
    if (original.completed) throw new Error('This task is already complete.')
    const project = original._ticktick?.projectId || source.id
    if (!isInbox(source) && project !== source.id) throw new Error('This task belongs to another TickTick list.')
    let task
    if (isInbox(source) && project === 'inbox' && !inboxProjectId) {
      const from = instant(original.start, timeZone)
      task = (await inboxTasks(from, from + DAY, [original.id])).find(row => row.id === original.id)
      if (!task) throw conflict()
    } else {
      try {
        task = await readTask(source, project === 'inbox' ? inboxProjectId : project, original.id)
      } catch (error) {
        if (error.status === 404) throw conflict()
        throw error
      }
    }
    const dates = schedule(task, timeZone)
    const fields = original._ticktick?.fields ?? []
    if (task.repeatFlag || (task.status ?? 0) !== 0 || version(task, dates, fields) !== original.version) throw conflict()
    return task
  }

  function matches(source, task, taskId, expected) {
    if (!task || task.id !== taskId || task.title !== expected.title || (task.status ?? 0) !== 0) return false
    const inInbox = isInbox(source) && expected.projectId === 'inbox' && task.projectId === inboxProjectId
    if (task.projectId !== expected.projectId && !inInbox) return false
    if (stable(schedule(task, timeZone)) !== stable(schedule(expected, timeZone))) return false
    return TASK_FIELDS.every(key => !Object.hasOwn(expected, key) || stable(task[key]) === stable(expected[key]))
  }

  async function save(source, path, body, taskId) {
    const reply = await request(path, { method: 'POST', body, write: true })
    if (!taskId && (typeof reply?.id !== 'string' || !reply.id.trim())) {
      throw failure('TickTick accepted the create without returning a task ID. Check the chosen list before creating it again.', 'UNCERTAIN')
    }
    const remoteId = taskId || reply.id
    try {
      let task = reply
      if (isInbox(source) && body.projectId === 'inbox' && !inboxProjectId) {
        const from = instant(schedule(body, timeZone).start, timeZone)
        const found = (await inboxTasks(from, from + DAY, [remoteId])).find(row => row.id === remoteId)
        task = found && { ...found, projectId: found.projectId || 'inbox' }
      } else if (!matches(source, task, remoteId, body)) {
        const project = body.projectId === 'inbox' ? inboxProjectId : body.projectId
        task = await readTask(source, project, remoteId)
      }
      if (matches(source, task, remoteId, body)) return normalize(source, task, timeZone)
    } catch {
      // The original write has already been sent.
    }
    const error = failure('TickTick accepted the request, but its saved dates or task fields could not be confirmed. Check the original task.', 'UNCERTAIN')
    error.providerId = remoteId
    throw error
  }

  async function create(source, draft) {
    writable(source)
    const fields = draftFields(draft, timeZone)
    if (isInbox(source) && source.id === 'inbox' && !inboxProjectId) {
      const from = instant(schedule(fields, timeZone).start, timeZone)
      await inboxTasks(from, from + DAY)
    }
    const projectId = isInbox(source) ? (inboxProjectId || source.id) : source.id
    return save(source, '/task', { projectId, ...fields })
  }

  async function update(source, original, draft) {
    const fresh = await current(source, original)
    const fields = draftFields(draft, timeZone, fresh)
    const projectId = fresh.projectId || original._ticktick?.projectId || source.id
    const body = { ...pick(fresh, TASK_FIELDS), id: original.id, projectId, ...fields }
    return save(source, '/task/' + encodeURIComponent(id(original.id)), body, original.id)
  }

  async function complete(source, original) {
    const fresh = await current(source, original)
    if (isInbox(source)) {
      const ids = await request('/task/completeTasks', { method: 'POST', body: { taskIds: [original.id] }, write: true })
      if (!Array.isArray(ids) || !ids.includes(original.id)) {
        throw failure('TickTick did not confirm completion of this Inbox task. Check the original task.', 'UNCERTAIN')
      }
      return normalize(source, { ...fresh, status: 2 }, timeZone)
    }
    const project = fresh.projectId || source.id
    await request(taskPath(project, original.id) + '/complete', { method: 'POST', write: true })
    try {
      const saved = await readTask(source, project, original.id)
      if (saved.status === 2) return normalize(source, { ...fresh, ...saved }, timeZone) ||
        { ...original, completed: true, canEdit: false, canComplete: false }
    } catch {
      // A task missing from the open list does not establish completion.
    }
    throw failure('TickTick accepted completion, but the completed status could not be confirmed. Check the original task.', 'UNCERTAIN')
  }

  return { sources, items, create, update, complete }
}
