import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createNotificationFixture } from './fixtures/notification-center.mjs';

export function civilDay(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
const stamp = (day, hour, minute = 0) => new Date(day + 'T' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':00').toISOString();
const tickStamp = value => new Date(value).toISOString().replace('Z', '+0000');

function fixtureAccount(day, zone, id, multipleAccounts) {
  const inbox = multipleAccounts ? (id === 'first' ? 'inbox101' : 'inbox202') : 'inbox-user';
  const midnight = tickStamp(stamp(day, 0));
  const originals = new Map();
  const projectGroups = [
    { id: 'archive', name: 'Archive', sortOrder: 900 },
    { id: 'personal', name: 'Personal', sortOrder: 400 },
    { id: 'work', name: 'Work', sortOrder: 100 },
  ];
  const projects = [
    { id: 'errands', name: 'Errands', groupId: 'personal', sortOrder: 20 },
    { id: 'planning', name: 'Planning tasks', groupId: 'work', sortOrder: 40, color: '#138179' },
    { id: 'reference', name: 'Reference files', groupId: 'archive', sortOrder: 10 },
    { id: 'desk', name: 'On my desk', sortOrder: 200 },
    { id: 'briefs', name: 'Briefs', groupId: 'work', sortOrder: -20 },
    { id: 'templates', name: 'Templates', sortOrder: -100 },
    { id: 'closed', name: 'Closed tasks', groupId: 'archive', sortOrder: 20, closed: true },
  ].map(project => ({ permission: 'write', ...project }));
  if (multipleAccounts) projects.push({ id: inbox, name: 'Inbox', permission: 'write' });
  originals.set('review', { id: 'review', projectId: 'planning', title: 'Review the launch plan', content: 'Keep these notes.',
    items: [{ id: 'checklist-one', title: 'Check the agenda', status: 0 }], tags: ['planning'], priority: 3,
    startDate: midnight, dueDate: midnight, timeZone: zone, isAllDay: true, status: 0 });
  originals.set('timed', { id: 'timed', projectId: 'planning', title: 'Prepare interview questions', status: 0,
    startDate: tickStamp(stamp(day, 14)), dueDate: tickStamp(stamp(day, 14, 45)), timeZone: zone, isAllDay: false });
  originals.set('inbox-one', { id: 'inbox-one', projectId: inbox, title: 'Read studio brief', status: 0,
    startDate: midnight, dueDate: midnight, timeZone: zone, isAllDay: true });
  for (const [id, projectId, title] of [
    ['brief-task', 'briefs', 'Read the design brief'],
    ['errand-task', 'errands', 'Collect the parcel'],
    ['closed-task', 'closed', 'Old research notes'],
  ]) {
    originals.set(id, { id, projectId, title, status: 0, startDate: midnight, dueDate: midnight, timeZone: zone, isAllDay: true });
  }
  const calendars = [
    { id: id === 'first' ? 'studio@example.test' : 'field@example.test', summary: 'Studio', accessRole: 'owner', primary: true, backgroundColor: '#366aba' },
    { id: 'bmw-copy', summary: 'BMW Work', accessRole: 'writer', backgroundColor: '#bb7046' },
    { id: 'tick-copy', summary: 'TickTick copies', accessRole: 'reader', backgroundColor: '#776cb2' }
  ];
  const events = new Map(calendars.map(calendar => [calendar.id, new Map()]));
  const addEvent = (calendar, id, title, start, end, extra = {}) => events.get(calendar).set(id, {
    id, summary: title, start: { dateTime: start }, end: { dateTime: end }, etag: '"1"', status: 'confirmed',
    eventType: 'default', organizer: { email: calendar, self: true }, description: 'Retain this original description.', ...extra
  });
  addEvent(calendars[0].id, 'studioevent', 'Design review', stamp(day, 10), stamp(day, 11));
  addEvent(calendars[0].id, 'meetingwithguests', 'Research roundtable', stamp(day, 13), stamp(day, 14), { attendees: [{ email: 'guest@example.test' }] });
  addEvent(calendars[0].id, 'weeklyinstance', 'Weekly check-in', stamp(day, 15), stamp(day, 15, 30),
    { recurringEventId: 'weeklyseries', originalStartTime: { dateTime: stamp(day, 15) } });
  addEvent('bmw-copy', 'bmwmeeting', 'BMW project sync', stamp(day, 10, 30), stamp(day, 11, 30));
  addEvent('tick-copy', 'tickcopy', 'Review the launch plan', stamp(day, 9), stamp(day, 9, 30));
  const suffix = id === 'first' ? '' : '-' + id;
  return { id, calendars, events, originals, projects, projectGroups, inbox, googleAccess: 'fixture-google-access' + suffix,
    googleRefresh: 'fixture-google-refresh' + suffix, tickToken: null };
}

export async function startProviderServer({ multipleAccounts = false } = {}) {
  const day = civilDay(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const accounts = [fixtureAccount(day, zone, 'first', multipleAccounts)];
  if (multipleAccounts) accounts.push(fixtureAccount(day, zone, 'second', true));
  const controls = { unavailable: new Set(), noTickId: false, requests: [] };
  const notifications = createNotificationFixture();
  const authorizations = new Map();
  const publicClients = new Map();
  let origin;

  const server = createServer(async (request, response) => {
    const u = new URL(request.url, origin), method = request.method;
    const buffers = [];
    for await (const chunk of request) buffers.push(chunk);
    const contents = Buffer.concat(buffers).toString();
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      if (method === 'POST' && u.pathname.startsWith('/notification-center/')) {
        return json(200, notifications.call(u.pathname, contents));
      }
      const isTickSignIn = u.pathname.startsWith('/tick/oauth/');
      const oauthPath = isTickSignIn ? u.pathname.slice(5) : u.pathname;
      if (isTickSignIn && oauthPath === '/oauth/register' && method === 'POST') {
        const registration = JSON.parse(contents);
        if (registration.token_endpoint_auth_method !== 'none' || registration.client_name !== 'Calendar Hub' ||
            registration.redirect_uris?.length !== 1) return json(400, { error: 'invalid_client_metadata' });
        const id = randomUUID();
        publicClients.set(id, registration.redirect_uris[0]);
        return json(201, { ...registration, client_id: id });
      }
      if (oauthPath === '/oauth/authorize') {
        const clientId = u.searchParams.get('client_id');
        if (isTickSignIn ? publicClients.get(clientId) !== u.searchParams.get('redirect_uri') : clientId !== 'fixture.apps.googleusercontent.com') return json(400);
        if (!u.searchParams.get('state') || !u.searchParams.get('code_challenge') || u.searchParams.get('code_challenge_method') !== 'S256') return json(400, { error: 'missing OAuth state or PKCE' });
        const id = randomUUID();
        authorizations.set(id, { ...Object.fromEntries(u.searchParams), ticktick: isTickSignIn });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        const picker = multipleAccounts ? '<label>Test account<select name="account"><option value="first">First account</option><option value="second">Second account</option></select></label>' : '';
        return response.end('<title>Test consent</title><form method="post" action="/oauth/consent"><input type="hidden" name="id" value="' + id + '">' + picker + '<button>' +
          (isTickSignIn ? 'Authorize test tasks' : 'Authorize test calendars') + '</button></form>');
      }
      if (u.pathname === '/oauth/consent' && method === 'POST') {
        const form = new URLSearchParams(contents), id = form.get('id'), auth = authorizations.get(id);
        const account = accounts.find(row => row.id === (form.get('account') || 'first'));
        if (!auth || !account) return json(400);
        auth.account = account;
        const callback = new URL(auth.redirect_uri);
        callback.searchParams.set('code', id); callback.searchParams.set('state', auth.state);
        response.writeHead(302, { location: callback.href }); return response.end();
      }
      if (oauthPath === '/oauth/token') {
        const form = new URLSearchParams(contents);
        if (form.get('grant_type') === 'authorization_code') {
          const auth = authorizations.get(form.get('code'));
          if (!auth?.account || auth.ticktick !== isTickSignIn || form.get('client_id') !== auth.client_id || form.get('redirect_uri') !== auth.redirect_uri ||
              createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== auth.code_challenge) return json(400, { error: 'invalid_grant' });
          authorizations.delete(form.get('code'));
          if (isTickSignIn) {
            if (form.has('client_secret') || form.get('scope') !== 'tasks:write tasks:read') return json(400, { error: 'invalid_request' });
            auth.account.tickToken = 'fixture-tick-token-' + randomUUID();
            return json(200, { access_token: auth.account.tickToken, token_type: 'bearer', expires_in: 3600, scope: auth.scope });
          }
          return json(200, { access_token: auth.account.googleAccess, refresh_token: auth.account.googleRefresh, token_type: 'Bearer', expires_in: 3600, scope: auth.scope });
        }
        const account = accounts.find(row => row.googleRefresh === form.get('refresh_token'));
        return account && !isTickSignIn ? json(200, { access_token: account.googleAccess, expires_in: 3600, token_type: 'Bearer' }) : json(401);
      }
      const isGoogle = u.pathname.startsWith('/google/calendar/v3/');
      const prefix = isGoogle ? '/google/calendar/v3' : '/tick/open/v1';
      if (!u.pathname.startsWith(prefix + '/')) return json(404);
      const parts = u.pathname.slice(prefix.length + 1).split('/').map(decodeURIComponent);
      const account = accounts.find(row => {
        const expected = isGoogle ? row.googleAccess : row.tickToken;
        return expected && request.headers.authorization === 'Bearer ' + expected;
      });
      if (!account) return json(401, { error: { message: 'Invalid test credential.' } });
      const { calendars, projects, projectGroups, originals, events, inbox } = account;
      const body = contents ? JSON.parse(contents) : {};
      controls.requests.push({ provider: isGoogle ? 'google' : 'ticktick', account: account.id, method, path: parts.join('/'), query: Object.fromEntries(u.searchParams) });
      if (isGoogle) {
        if (parts.join('/') === 'users/me/calendarList') {
          return u.searchParams.has('pageToken') ? json(200, { items: calendars.slice(2) }) : json(200, { items: calendars.slice(0, 2), nextPageToken: 'more' });
        }
        const [, calendarId, resource, id] = parts, entries = events.get(calendarId);
        if (resource !== 'events' || !entries) return json(404);
        if (controls.unavailable.has(calendarId)) return json(503, { error: { message: 'Calendar temporarily unavailable.' } });
        if (method === 'GET' && !id) {
          const from = Date.parse(u.searchParams.get('timeMin')), until = Date.parse(u.searchParams.get('timeMax'));
          const instant = boundary => Date.parse(boundary.dateTime || boundary.date + 'T00:00:00');
          const items = [...entries.values()].filter(item => instant(item.start) < until && instant(item.end) > from);
          return json(200, { items, timeZone: zone });
        }
        const original = entries.get(id);
        if (method === 'GET') return original ? json(200, original) : json(404);
        if (method === 'POST') {
          if (entries.has(body.id)) return json(409);
          const item = { ...body, id: body.id, status: 'confirmed', etag: '"1"', organizer: { self: true, email: calendarId } };
          entries.set(item.id, item); return json(200, item);
        }
        if (!original) return json(404);
        if (request.headers['if-match'] !== original.etag) return json(412, { error: { message: 'Changed on the server.' } });
        if (method === 'PATCH') {
          Object.assign(original, body, { etag: '"' + (Number(original.etag.replaceAll('"', '')) + 1) + '"' });
          return json(200, original);
        }
        if (method === 'DELETE') { entries.delete(id); return json(204); }
      } else {
        const [first, second, third, id, action] = parts;
        if (first === 'project' && !second) {
          const offset = Number(u.searchParams.get('offset') || 0);
          const limit = Number(u.searchParams.get('limit') || 50);
          return json(200, projects.slice(offset, offset + limit));
        }
        if (first === 'project' && second === 'group' && parts.length === 2) return json(200, projectGroups);
        if (first === 'project' && third === 'data') return json(200, { project: projects.find(p => p.id === second), tasks: [...originals.values()].filter(t => t.projectId === second && !t.status) });
        if (first === 'project' && third === 'task') {
          const original = originals.get(id);
          if (!original || original.projectId !== second) return json(404);
          if (method === 'GET') return json(200, original);
          if (action === 'complete' && method === 'POST') { original.status = 2; return json(200); }
        }
        if (first === 'task' && second === 'undone') return json(200, [...originals.values()].filter(item => item.projectId === inbox && !item.status));
        if (first === 'task' && second === 'completeTasks') {
          for (const id of body.taskIds) if (originals.has(id)) originals.get(id).status = 2;
          return json(200, body.taskIds);
        }
        if (first === 'task' && !second && method === 'POST') {
          const item = { status: 0, ...body, id: randomUUID() };
          originals.set(item.id, item);
          if (controls.noTickId) { controls.noTickId = false; return json(201); }
          return json(201, item);
        }
        if (first === 'task' && method === 'POST') {
          const original = originals.get(second);
          if (!original || original.projectId !== body.projectId || body.id !== second) return json(400);
          Object.assign(original, body); return json(200, original);
        }
      }
      return json(404);
    } catch (error) { return json(500, { error: { message: error.message } }); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  const { originals, events, projects, projectGroups } = accounts[0];
  return { origin, day, accounts, originals, events, projects, projectGroups, controls, notifications: notifications.state,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
