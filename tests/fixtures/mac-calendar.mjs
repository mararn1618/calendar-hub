import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createNotificationFixture } from './notification-center.mjs';

export async function startMacCalendarFixture(calendars) {
  const events = new Map();
  const calls = [];
  const notifications = createNotificationFixture();
  const server = createServer(async (request, response) => {
    const reply = (result, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    };
    if (request.method !== 'POST') return reply({}, 404);
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const contents = Buffer.concat(chunks).toString();
      if (request.url.startsWith('/notification-center/')) return reply(notifications.call(request.url, contents));
      if (request.url !== '/mac-helper') return reply({}, 404);
      const { args, input } = JSON.parse(contents);
      const [action, route, calendarId, start, end] = args;
      calls.push({ action, route, calendarId, input });
      if (!['mac', 'google'].includes(route)) return reply({ error: 'Invalid route.', code: 'INVALID' });
      const discovered = calendars.filter(calendar => route === 'mac' || calendar.calDAV);
      if (action === 'authorize' || action === 'sources') {
        return reply(discovered.map(({ id, name, accountName, writable }) => ({ id, name, accountName, writable: route === 'google' && writable })));
      }
      const calendar = discovered.find(row => row.id === calendarId);
      if (!calendar) return reply({ error: 'Calendar unavailable.', code: 'UNAVAILABLE' });
      const rows = [...events.values()].filter(row => row.providerCalendarId === calendarId);
      if (action === 'items') {
        const from = new Date(start + 'T00:00:00'), until = new Date(end + 'T00:00:00');
        return reply(rows.filter(row => row.allDay ? row.start < end && row.end > start : Date.parse(row.start) < +until && Date.parse(row.end) > +from)
          .map(row => ({ ...row, canEdit: route === 'google' && calendar.writable, canDelete: route === 'google' && calendar.writable })));
      }
      if (route !== 'google' || !calendar.writable) return reply({ error: 'Calendar is read-only.', code: 'READ_ONLY' });
      if (!['create', 'update'].includes(action) || !input?.draft) return reply({ error: 'Invalid write.', code: 'INVALID' });

      const previous = events.get(input.original?.id);
      if (action === 'update' && (!previous || previous.providerCalendarId !== calendarId || previous.version !== input.original.version || previous.start !== input.original.start)) {
        return reply({ error: 'Event changed.', code: 'CONFLICT' });
      }
      const event = {
        ...input.draft, id: previous?.id ?? randomUUID(), version: randomUUID(), providerCalendarId: calendarId,
        canEdit: true, canDelete: true, recurring: false, hasAttendees: false, completed: false, canComplete: false,
      };
      events.set(event.id, event);
      return reply(event);
    } catch (error) {
      return reply({ error: error.message, code: 'FIXTURE' }, 500);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    calls, events, notifications: notifications.state, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
