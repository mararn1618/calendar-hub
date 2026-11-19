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
      const [action, route] = args;
      const lengths = { authorize: 2, accounts: 2, sources: 2, items: 5, create: 3, update: 3, remove: 3 };
      const length = lengths[action], [, , calendarId, start, end] = args.slice(0, length);
      const scope = args.length === length + 1 ? JSON.parse(args[length]) : {};
      calls.push({ action, route, calendarId, input, accountId: scope.accountId });
      if (!['mac', 'google', 'exchange'].includes(route) || !length) return reply({ error: 'Invalid route.', code: 'INVALID' });
      const writing = ['create', 'update', 'remove'].includes(action);
      if (writing && route !== 'google') return reply({ error: 'Calendar is read-only.', code: 'READ_ONLY' });
      const accountInventory = action === 'authorize' || action === 'accounts';
      if (route === 'exchange' && !accountInventory && !scope.accountId) return reply({ error: 'Choose an Exchange account.', code: 'INVALID' });
      if (route === 'google' && !accountInventory && !Array.isArray(scope.googleCalendarIds)) return reply({ error: 'Choose Google calendars.', code: 'INVALID' });
      const discovered = calendars.filter(calendar => route === 'mac' || (route === 'google' ? calendar.calDAV : calendar.exchange))
        .map(calendar => ({ ...calendar, accountId: calendar.accountId ?? 'fixture:' + (calendar.accountName ?? calendar.id) }))
        .filter(calendar => (!scope.accountId || scope.accountId === calendar.accountId) &&
          (!scope.googleCalendarIds || scope.googleCalendarIds.includes(calendar.id)));
      if (accountInventory || action === 'sources') {
        return reply(discovered.map(({ id, name, accountId, accountName, writable }) => ({ id, name, accountId, accountName, writable: route === 'google' && writable })));
      }
      const calendar = discovered.find(row => row.id === calendarId);
      if (!calendar) return reply({ error: 'Calendar unavailable.', code: 'UNAVAILABLE' });
      const rows = [...events.values()].filter(row => row.providerCalendarId === calendarId);
      if (action === 'items') {
        const from = new Date(start + 'T00:00:00'), until = new Date(end + 'T00:00:00');
        return reply(rows.filter(row => row.allDay ? row.start < end && row.end > start : Date.parse(row.start) < +until && Date.parse(row.end) > +from)
          .map(row => ({ ...row, canEdit: route === 'google' && calendar.writable, canDelete: route === 'google' && calendar.writable })));
      }
      if (!calendar.writable) return reply({ error: 'Calendar is read-only.', code: 'READ_ONLY' });
      const previous = events.get(input.original?.id);
      if (action !== 'create' && (!previous || previous.providerCalendarId !== calendarId || previous.version !== input.original.version || previous.start !== input.original.start)) {
        return reply({ error: 'Event changed.', code: 'CONFLICT' });
      }
      if (action === 'remove') {
        events.delete(previous.id);
        return reply({ removed: true });
      }
      if (!input?.draft) return reply({ error: 'Invalid write.', code: 'INVALID' });
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
