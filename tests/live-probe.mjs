// Playwright runs this function in Electron's main process. Credentials stay in that process.
export function openProviderProbe({ app, safeStorage }, { kind, sourceId, title, nativeExecutable }) {
  if (!app.isPackaged || process.argv.some(arg => arg.startsWith('--calendar-test-config='))) throw new Error('Wrong profile.');
  const path = process.getBuiltinModule('path').join(app.getPath('userData'), 'calendar.json');
  const { sources, connections } = JSON.parse(process.getBuiltinModule('fs').readFileSync(path, 'utf8'));
  const source = sources.find(row => row.id === sourceId && row.provider === kind && row.available !== false);
  const account = connections.find(row => row.id === source?.connectionId && row.provider === kind);
  if (!account?.secret || !source.selected || !source.writable) throw new Error('Selected test destination unavailable.');
  const secret = JSON.parse(safeStorage.decryptString(Buffer.from(account.secret, 'base64')));
  const list = source.remoteId;
  if (kind === 'google' && secret.route === 'mac') {
    if (!secret.googleCalendarIds?.includes(list) || !nativeExecutable) throw new Error('Selected Mac calendar unavailable.');
    const execute = process.getBuiltinModule('util').promisify(process.getBuiltinModule('child_process').execFile);
    return async ({ action = 'read', id, timing = {} }) => {
      const { stdout } = await execute(nativeExecutable, [JSON.stringify({ action, id, list, title, ...timing })],
        { timeout: 120_000, maxBuffer: 32_768 });
      return JSON.parse(stdout);
    };
  }
  const encoded = encodeURIComponent(list);
  const googleBase = 'https://www.googleapis.com/calendar/v3/calendars/' + encoded + '/events/';
  const tickBase = 'https://api.ticktick.com/open/v1';
  async function accessToken() {
    if (kind === 'ticktick') return secret.token;
    if (!secret.accessToken || secret.expiresAt <= Date.now() + 30_000) {
      const body = new URLSearchParams({ client_id: secret.clientId, refresh_token: secret.refreshToken, grant_type: 'refresh_token' });
      if (secret.clientSecret) body.set('client_secret', secret.clientSecret);
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body,
        redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('Independent Google authorization expired.');
      const renewed = await response.json();
      secret.accessToken = renewed.access_token;
      secret.expiresAt = Date.now() + 1000 * renewed.expires_in;
    }
    return secret.accessToken;
  }
  function taskRow(item) {
    const start = item.startDate || item.dueDate, end = item.dueDate || start;
    const civil = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    const allDay = item.isAllDay === true || (civil(start) && civil(end));
    let day;
    if (allDay && start) {
      day = civil(start) ? start : new Intl.DateTimeFormat('sv-SE', {
        timeZone: item.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(start));
    }
    const checklist = item.items || [];
    const details = JSON.stringify([item.content || '', item.desc || '', checklist.map(entry =>
      [entry.id, entry.title, entry.status, entry.sortOrder, entry.startDate, entry.isAllDay, entry.timeZone, entry.completedTime])]);
    return { allDay, day, start, end, completed: item.status === 2,
      detailsExposed: (Object.hasOwn(item, 'desc') || Object.hasOwn(item, 'content')) && Array.isArray(item.items),
      signature: process.getBuiltinModule('crypto').createHash('sha256').update(details).digest('hex'),
      hasNotes: [item.content, item.desc].includes(title + ' notes'),
      hasChecklist: checklist.some(entry => entry.title === title + ' checklist' && entry.id) };
  }
  return async ({ id, action = 'read', timing }) => {
    if (!['google', 'ticktick'].includes(kind) || typeof id !== 'string' || !id.trim() || id === '.' || id === '..') return { error: 'invalid target' };
    const token = await accessToken();
    if (!token) return { error: 'missing authorization' };
    const options = { redirect: 'error', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } };
    const request = (url, extra) => fetch(url, { ...options, ...extra, signal: AbortSignal.timeout(20_000) });
    const itemPath = encodeURIComponent(id);
    const url = kind === 'ticktick' ? tickBase + '/project/' + encoded + '/task/' + itemPath : googleBase + itemPath;
    const readUrl = kind === 'ticktick' ? url : url + '?fields=id,iCalUID,etag,summary,status,start,end,organizer(self),attendees(responseStatus),attendeesOmitted,recurrence,recurringEventId,eventType,locked';
    const response = await request(readUrl);
    let item;
    if (kind === 'ticktick' && action === 'completed' && [404, 410].includes(response.status)) {
      const completed = await request(tickBase + '/task/completed', { method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectIds: [list], startDate: timing.since, endDate: new Date().toISOString().replace('Z', '+0000') }) });
      if (!completed.ok) return { unavailable: 'TickTick did not expose the completed record for verification.' };
      const rows = await completed.json();
      if (!Array.isArray(rows)) return { unavailable: 'TickTick did not return completed tasks for this test window.' };
      const matches = rows.filter(task => task.id === id && task.projectId === list);
      if (matches.length !== 1) return { missing: true };
      item = matches[0];
    } else {
      if ([404, 410].includes(response.status)) return { missing: true };
      if (!response.ok) return { error: 'first-party read returned HTTP ' + response.status };
      item = await response.json();
    }
    if (item.id !== id) return { error: 'provider returned another ID' };
    if (kind === 'google' && item.status === 'cancelled') return { missing: true };
    if ((kind === 'google' ? item.summary : item.title) !== title) return { error: 'run-specific title changed' };
    if (kind === 'ticktick') {
      if (item.projectId !== list || item.repeatFlag) return { error: 'task list or recurrence changed' };
      if (action === 'read' || action === 'completed') return taskRow(item);
      if (action !== 'seed' || (item.status ?? 0) !== 0 || item.content || item.desc || item.items?.length) {
        return { error: 'task is no longer the new empty task from this run' };
      }
      const body = { id, projectId: list, title, kind: 'CHECKLIST', desc: title + ' notes',
        items: [{ title: title + ' checklist', status: 0, sortOrder: 0 }] };
      for (const key of ['isAllDay', 'startDate', 'dueDate', 'timeZone', 'reminders', 'tags', 'priority', 'sortOrder']) {
        if (Object.hasOwn(item, key)) body[key] = item[key];
      }
      const saved = await request(tickBase + '/task/' + itemPath, { method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await saved.body?.cancel();
      return saved.ok ? { sent: true } : { error: 'checklist setup returned HTTP ' + saved.status };
    }
    if (item.attendees?.length || item.attendeesOmitted || item.recurrence || item.recurringEventId) {
      return { error: 'event acquired guests or recurrence' };
    }
    const row = { allDay: !!item.start?.date, start: item.start?.dateTime, end: item.end?.dateTime, externalId: item.iCalUID };
    if (action === 'read') return row;
    if (action !== 'move' || !item.organizer?.self || item.locked || (item.eventType && item.eventType !== 'default') ||
        !/^"[^"]+"$/.test(item.etag) || Date.parse(row.start) !== Date.parse(timing.fromStart) || Date.parse(row.end) !== Date.parse(timing.fromEnd)) {
      return { error: 'event owner, version or original times changed' };
    }
    const moved = await request(url + '?sendUpdates=none', { method: 'PATCH',
      headers: { ...options.headers, 'If-Match': item.etag, 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: { dateTime: timing.toStart }, end: { dateTime: timing.toEnd } }) });
    await moved.body?.cancel();
    return moved.ok ? { sent: true } : { error: 'external move returned HTTP ' + moved.status };
  };
}
