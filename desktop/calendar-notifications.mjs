import { createHash } from 'node:crypto';

const defaults = { enabled: false, leadMinutes: 10 };
const minute = 60_000;
const denied = 'Open System Settings > Notifications > Calendar Hub and turn on Allow Notifications.';
const unavailable = 'Calendar Hub could not access Mac notifications. Open the installed app and try again.';

function localDay(ms, offset = 0) {
  const day = new Date(ms);
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() + offset);
  return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-');
}

function horizon(now) {
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  return end.getTime();
}

function inCurrentMode(connection, id) {
  const [account, kind, groupId] = JSON.parse(id);
  if (account !== connection.id) return false;
  if (connection.provider !== 'ticktick') return true;
  const { mode, groups, includedSourceIds } = connection.ticktick;
  if (includedSourceIds?.length === 0) return false;
  if (mode === 'account') return kind === 'account';
  if (mode === 'folders') return kind === 'folder' || kind === 'unfiled';
  return kind === 'remainder' || (kind === 'custom' && groups.some(group => group.id === groupId));
}

function reminderWarning(failures, routes) {
  if (!failures.size) return null;
  const affected = new Set(routes.filter(({ source }) => failures.has(source.id) || failures.has(source.connectionId))
    .map(route => route.calendarId));
  const count = affected.size;
  const scope = count ? ' for ' + count + (count === 1 ? ' calendar' : ' calendars') : '';
  const summary = 'Could not refresh reminders' + scope + '.';
  const reasons = new Set(failures.values());
  const [reason] = reasons;
  return reasons.size === 1 && reason && reason.length <= 160 ? summary + ' ' + reason : summary;
}

function requestsFor(routes, cache, now) {
  const until = horizon(now);
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const requests = new Map();
  for (const { source, name, leadMinutes } of routes) {
    for (const item of cache[source.id]?.items ?? []) {
      if (!item.id || item.movedToSourceId || item.allDay || item.completed || item.cancelled || item.status === 'cancelled' ||
          typeof item.start !== 'string' || !item.start.includes('T')) continue;
      const start = Date.parse(item.start);
      const fire = start - leadMinutes * minute;
      if (!(fire > now && fire < until)) continue;
      const owner = source.provider === 'ticktick' ? source.connectionId : source.id;
      const id = createHash('sha256').update(JSON.stringify([owner, item.id])).digest('hex');
      requests.set(id, { id, title: item.title, body: name + ' · ' + format.format(start), fireAt: new Date(fire).toISOString() });
    }
  }
  return [...requests.values()].sort((a, b) => a.fireAt.localeCompare(b.fireAt) || a.id.localeCompare(b.id));
}

export class CalendarNotifications {
  constructor(service, center) {
    this.service = service;
    this.data = service.data;
    this.center = center;
    this.leads = new Map();
    this.failures = new Map();
    this.error = null;
  }

  preferences() {
    return Object.fromEntries(this.service.displayCalendars().map(({ id }) => [id, this.data.notificationPreferences?.[id] ?? defaults]));
  }

  observeTickTickItems(source, items) {
    if (source.provider !== 'ticktick' || !items.length || !Object.entries(this.data.notificationPreferences ?? {})
      .some(([id, preference]) => preference.enabled && JSON.parse(id)[0] === source.connectionId)) return;
    const ids = new Set(items.map(item => item.id));
    for (const [id, cache] of Object.entries(this.data.cache)) {
      if (id === source.id || JSON.parse(id)[0] !== source.connectionId) continue;
      for (const previous of cache.items) if (ids.has(previous.id)) previous.movedToSourceId = source.id;
    }
  }

  async set({ calendarId, enabled, leadMinutes }) {
    if (!this.service.displayCalendars().some(calendar => calendar.id === calendarId)) throw new Error('Choose an available calendar for reminders.');
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Choose whether to enable calendar reminders.');
    if (leadMinutes !== undefined && (!Number.isInteger(leadMinutes) || leadMinutes < 0 || leadMinutes > 10080)) {
      throw new Error('Enter a reminder time between 0 and 10080 whole minutes.');
    }
    const old = this.data.notificationPreferences?.[calendarId] ?? defaults;
    const next = { enabled: enabled ?? old.enabled, leadMinutes: leadMinutes ?? old.leadMinutes };
    if (old.enabled === next.enabled && old.leadMinutes === next.leadMinutes) return;
    const turningOn = next.enabled && !old.enabled;
    if (turningOn) {
      let status = await this.center?.authorization();
      if (status === 'undetermined') status = await this.center.requestAuthorization();
      if (status !== 'allowed') throw new Error(status === 'denied' ? denied : unavailable);
    }
    this.data.notificationPreferences ??= {};
    this.data.notificationPreferences[calendarId] = next;
    this.service.profile.save();
    if (old.enabled || next.enabled) await this.refresh({ read: next.enabled ? 'calendar' : 'none', calendarId, authorized: turningOn });
  }

  async replace(requests, force) {
    if (!requests.length && !this.data.notificationRequestsPending) return;
    const serialized = JSON.stringify(requests);
    if (!force && this.lastApplied === serialized) return;
    this.lastApplied = null;
    if (!this.center) throw new Error(unavailable);
    if (requests.length && !this.data.notificationRequestsPending) {
      this.data.notificationRequestsPending = true;
      this.service.profile.save();
    }
    await this.center.replace(requests);
    if (!requests.length) {
      this.data.notificationRequestsPending = false;
      this.service.profile.save();
    }
    this.lastApplied = serialized;
  }

  async refresh({ read = 'all', calendarId, discover = false, authorized = false, checkedRange, writtenItems } = {}) {
    const enabled = Object.keys(this.data.notificationPreferences ?? {}).filter(id => this.data.notificationPreferences[id].enabled);
    const accounts = enabled.length ? this.data.connections.filter(connection => enabled.some(id => inCurrentMode(connection, id))) : [];
    try {
      if (!accounts.length) {
        this.leads.clear();
        this.failures.clear();
        await this.replace([], true);
        this.error = null;
        return;
      }
      if (authorized) this.authorization = 'allowed';
      else if (read === 'all' || !this.authorization || read !== 'none' && this.authorization !== 'allowed') {
        this.authorization = await this.center?.authorization();
      }
      if (this.authorization !== 'allowed') {
        if (this.authorization === 'denied' || this.authorization === 'undetermined') await this.replace([], true);
        this.error = this.authorization === 'unavailable' || !this.authorization ? unavailable : denied;
        return;
      }
      if (discover) {
        await Promise.all(accounts.map(async connection => {
          try {
            this.service.updateSources(connection, await this.service.client(connection).sources());
            this.failures.delete(connection.id);
          } catch (error) { this.failures.set(connection.id, error.message); }
        }));
        this.service.profile.save();
      } else if (checkedRange) {
        for (const connection of accounts) {
          const failure = checkedRange.health.find(entry => entry.connectionId === connection.id && !entry.sourceId);
          if (failure) this.failures.set(connection.id, failure.message);
          else this.failures.delete(connection.id);
        }
      }
      const sources = new Map(this.data.sources.map(source => [source.id, source]));
      const routes = this.service.displayCalendars().filter(calendar => this.data.notificationPreferences[calendar.id]?.enabled)
        .flatMap(calendar => calendar.sourceIds.map(id => ({ source: sources.get(id), name: calendar.name, calendarId: calendar.id,
          leadMinutes: this.data.notificationPreferences[calendar.id].leadMinutes })));
      const live = new Set([...accounts.map(account => account.id), ...routes.map(route => route.source.id)]);
      for (const id of this.failures.keys()) if (!live.has(id)) this.failures.delete(id);
      if (read !== 'none') await this.load(read === 'calendar' ? routes.filter(route => route.calendarId === calendarId) : routes,
        accounts, read, checkedRange, writtenItems);
      this.leads = new Map(routes.map(route => [route.source.id, route.leadMinutes]));
      const requests = requestsFor(routes, this.data.cache, Date.now());
      await this.replace(requests, read === 'all');
      this.error = reminderWarning(this.failures, routes);
    } catch (error) {
      this.lastApplied = null;
      this.error = 'Could not update calendar reminders. ' + error.message;
    }
  }

  async load(routes, accounts, read, checkedRange, writtenItems) {
    const now = Date.now(), until = horizon(now);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const jobs = [];
    for (const route of routes) {
      const { source, leadMinutes } = route;
      if (read === 'changed' && this.leads.get(source.id) === leadMinutes) continue;
      const offset = leadMinutes * minute;
      const start = localDay(now + offset), end = localDay(until + offset - 1, 1);
      if (checkedRange && checkedRange.start <= start && checkedRange.end >= end) {
        const check = checkedRange.health.find(entry => entry.sourceId === source.id);
        if (check) {
          this.rememberCheck(source, check);
          continue;
        }
      }
      const recent = this.data.cache[source.id]?.checks.some(check => check.zone === zone && check.start <= start &&
        check.end >= end && now - Date.parse(check.checkedAt) < 5 * minute);
      if (read === 'changed' && recent) continue;
      jobs.push({ source, start, end, zone, writtenItems });
    }
    if (!jobs.length) return;
    await Promise.all(accounts.map(async connection => {
      const remaining = jobs.filter(job => job.source.connectionId === connection.id);
      if (!remaining.length) return;
      let client;
      try { client = this.service.client(connection); }
      catch (error) { this.failures.set(connection.id, error.message); }
      const iterator = remaining.values();
      const worker = async () => {
        for (const job of iterator) {
          const check = await this.service.refreshSource(job.source, connection, client, job);
          this.rememberCheck(job.source, check);
        }
      };
      const limit = connection.provider === 'ticktick' ? 4 : 1;
      await Promise.all(Array.from({ length: Math.min(limit, remaining.length) }, worker));
    }));
    this.service.profile.save();
  }

  rememberCheck(source, check) {
    if (check.state === 'current') this.failures.delete(source.id);
    else this.failures.set(source.id, check.message);
  }
}
