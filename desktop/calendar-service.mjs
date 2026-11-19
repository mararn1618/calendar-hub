import { randomUUID } from 'node:crypto';

const calendarDay = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = date => date.toISOString().slice(0, 10);
const key = (connectionId, remoteId) => JSON.stringify([connectionId, remoteId]);
const matches = (entry, sourceId, id) => entry.sourceId === sourceId && entry.id === id;
const currentTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const tickTickInbox = source => source?.inbox || /^inbox(?:\d+)?$/.test(source?.id);
const tickTickInboxId = sources => sources.find(source => tickTickInbox(source) && source.id !== 'inbox')?.id;

function isDay(value) {
  if (typeof value !== 'string' || !calendarDay.test(value)) return false;
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(+parsed) && isoDay(parsed) === value;
}

function validateRange(start, end) {
  if (!isDay(start) || !isDay(end) || start >= end || Date.parse(end) - Date.parse(start) > 370 * 86400000) {
    throw new Error('Choose a calendar range between one day and one year.');
  }
}

function overlaps(item, start, end) {
  if (item.allDay) return item.start < end && item.end > start;
  const from = +new Date(start + 'T00:00:00'), until = +new Date(end + 'T00:00:00');
  const first = Date.parse(item.start), last = Date.parse(item.end);
  return first < until && (last > from || (first === last && first >= from));
}

function checkedDraft(input, provider) {
  const { start, end } = input;
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new Error('Enter a title.');
  if (input.allDay) {
    if (!isDay(start) || !isDay(end) || end <= start) throw new Error('Check the all-day dates.');
  } else {
    const first = Date.parse(start), last = Date.parse(end);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || (last === first && provider !== 'ticktick')) {
      throw new Error('Check the start and end times.');
    }
  }
  return { title, start, end, allDay: Boolean(input.allDay), notify: input.notify === true, occurrence: input.occurrence === true };
}

function publicItem(item, source) {
  return {
    id: item.id, sourceId: source.id, title: item.title, start: item.start, end: item.end,
    allDay: item.allDay, completed: Boolean(item.completed), version: item.version,
    recurring: Boolean(item.recurring), hasAttendees: Boolean(item.hasAttendees),
    canEdit: Boolean(source.writable && !source.readOnly && item.canEdit),
    canComplete: Boolean(source.writable && !source.readOnly && item.canComplete),
    canDelete: Boolean(source.writable && !source.readOnly && item.canDelete)
  };
}

export class CalendarService {
  constructor(profile, providers) {
    this.profile = profile;
    this.data = profile.data;
    this.data.unavailableSourceSettings ??= {};
    this.providers = providers;
    this.clients = new Map();
    this.queue = Promise.resolve();
  }

  run(operation, input = {}) {
    if (operation === 'connect') return this.connect(input);
    if (operation === 'macGoogleCalendars') return this.macGoogleCalendars();
    return this.enqueue(() => this[operation](input));
  }

  enqueue(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  async macGoogleCalendars() {
    const candidates = await this.providers.macGoogleCalendars();
    const connection = this.data.connections.find(entry => entry.provider === 'google' && entry.route === 'mac');
    const chosen = new Set(connection ? this.profile.open(connection).googleCalendarIds : []);
    return candidates.map(candidate => ({ ...candidate, chosen: chosen.has(candidate.id) }));
  }

  client(connection) {
    const timeZone = currentTimeZone();
    const cached = this.clients.get(connection.id);
    if (cached && cached.timeZone === timeZone) return cached.client;
    const client = this.providers.client(connection.provider, this.profile.open(connection));
    this.clients.set(connection.id, { client, timeZone });
    return client;
  }

  updateSources(connection, discovered) {
    const present = new Set();
    const unavailable = this.data.unavailableSourceSettings;
    for (const remote of discovered) {
      const id = key(connection.id, remote.id);
      present.add(id);
      const previous = this.data.sources.find(source => source.id === id);
      const details = {
        id, remoteId: remote.id, connectionId: connection.id, provider: connection.provider,
        name: remote.name, color: remote.color, writable: Boolean(remote.writable), remote
      };
      if (previous) Object.assign(previous, details);
      else {
        const settings = unavailable[id] ?? { selected: false, readOnly: !remote.writable };
        this.data.sources.push({ ...details, ...settings });
        delete unavailable[id];
      }
    }
    this.data.sources = this.data.sources.filter(source => {
      if (source.connectionId !== connection.id || present.has(source.id)) return true;
      unavailable[source.id] = { selected: source.selected, readOnly: source.readOnly };
      return false;
    });
  }

  async connect(input) {
    const { provider, connectionId } = input;
    const previousSecret = connectionId === undefined ? undefined : this.tickTickConnection(provider, connectionId).secret;
    if (provider === 'google' && input.route !== 'mac' && !input.clientId && !this.providers.connectionOptions?.googleBrowser) {
      const account = this.data.connections.find(entry => entry.provider === 'google' && entry.route !== 'mac');
      if (account) {
        const { clientId, clientSecret } = this.profile.open(account);
        if (clientId) input = { ...input, clientId, clientSecret };
      }
    }
    const secret = await this.providers.authorize(input);
    const timeZone = currentTimeZone();
    const client = this.providers.client(provider, secret);
    const discovered = await client.sources();
    if (secret.route === 'mac' && !secret.googleCalendarIds.every(id => discovered.some(source => source.id === id))) {
      throw new Error('A chosen calendar is no longer available. Check your Google calendars in Apple Calendar and choose again.');
    }
    const accountKey = this.providers.identity(provider, secret, discovered);
    return this.enqueue(() => this.storeConnection({ input, secret, client, discovered, accountKey, timeZone, previousSecret }));
  }

  tickTickConnection(provider, id) {
    const connection = provider === 'ticktick' && this.data.connections.find(entry => entry.provider === provider && entry.id === id);
    if (!connection) throw new Error('This TickTick connection is unavailable. Open Calendars and choose a saved account.');
    return connection;
  }

  matchesTickTickAccount(connection, discovered) {
    const known = this.data.sources.filter(source => source.provider === 'ticktick');
    const previous = known.filter(source => source.connectionId === connection.id);
    const previousInbox = tickTickInboxId(previous.map(source => source.remote));
    const discoveredInbox = tickTickInboxId(discovered);
    if (previousInbox && discoveredInbox) return previousInbox === discoveredInbox;

    const projects = new Set(discovered.filter(source => !tickTickInbox(source)).map(source => source.id));
    const otherProjects = new Set(known.filter(source => source.connectionId !== connection.id && !tickTickInbox(source.remote))
      .map(source => source.remoteId));
    return previous.some(source => !tickTickInbox(source.remote) && projects.has(source.remoteId) && !otherProjects.has(source.remoteId));
  }

  storeConnection({ input, secret, client, discovered, accountKey, timeZone, previousSecret }) {
    const { provider, connectionId } = input;
    const existing = this.data.connections.find(entry => entry.provider === provider && entry.accountKey === accountKey);
    const target = connectionId === undefined ? undefined : this.tickTickConnection(provider, connectionId);
    if (target) {
      if (target.secret !== previousSecret) throw new Error('This TickTick connection changed during sign-in. Open Calendars and try again.');
      if (existing && existing !== target) throw new Error('This TickTick token is already connected to another saved account.');
      if (!existing && !this.matchesTickTickAccount(target, discovered)) {
        throw new Error('Calendar Central could not match the task lists to this saved connection. Sign in with the same TickTick account, or add a separate connection.');
      }
    }
    let connection = target ?? existing;
    const name = target?.name || String(input.name || '').trim() || (provider === 'ticktick' && existing?.name) ||
      (secret.route === 'mac' && 'Google via Apple Calendar') || discovered.find(source => source.primary)?.name
      || ({ ticktick: 'TickTick', google: 'Google Calendar', mac: 'Mac calendars' })[provider];
    const encrypted = this.profile.seal(secret);
    if (!connection) {
      connection = { id: randomUUID(), provider, accountKey, name, secret: encrypted };
      this.data.connections.push(connection);
    } else Object.assign(connection, { accountKey, name, secret: encrypted });
    if (secret.route === 'mac') connection.route = 'mac';
    const previous = secret.route === 'mac' ? new Set(this.data.sources.filter(source => source.connectionId === connection.id).map(source => source.id)) : null;
    this.clients.set(connection.id, { client, timeZone });
    this.updateSources(connection, discovered);
    if (previous) {
      for (const source of this.data.sources) {
        if (source.connectionId === connection.id && !previous.has(source.id)) source.selected = true;
      }
    }
    this.profile.save();
  }

  disconnect({ connectionId }) {
    if (this.data.journal.some(entry => entry.connectionId === connectionId)) {
      throw new Error('Review the unconfirmed changes before disconnecting this account.');
    }
    const belongs = sourceId => JSON.parse(sourceId)[0] === connectionId;
    this.data.connections = this.data.connections.filter(c => c.id !== connectionId);
    this.data.sources = this.data.sources.filter(s => s.connectionId !== connectionId);
    this.data.hidden = this.data.hidden.filter(h => !belongs(h.sourceId));
    for (const id of Object.keys(this.data.cache)) if (belongs(id)) delete this.data.cache[id];
    for (const id of Object.keys(this.data.unavailableSourceSettings)) {
      if (belongs(id)) delete this.data.unavailableSourceSettings[id];
    }
    this.clients.delete(connectionId);
    this.profile.save();
  }

  setSource({ sourceId, selected, readOnly }) {
    const source = this.source(sourceId);
    if (typeof selected === 'boolean') source.selected = selected;
    if (typeof readOnly === 'boolean') source.readOnly = !source.writable || readOnly;
    this.profile.save();
  }

  source(id) {
    const source = this.data.sources.find(entry => entry.id === id);
    if (!source) throw new Error('This calendar is unavailable. Refresh the calendar list.');
    return source;
  }

  cache(sourceId) {
    return this.data.cache[sourceId] ??= { items: [], checks: [] };
  }

  async state({ start, end }) {
    validateRange(start, end);
    const health = [];
    await Promise.all(this.data.connections.map(async connection => {
      let client;
      try {
        client = this.client(connection);
        this.updateSources(connection, await client.sources());
      } catch (error) {
        health.push({ connectionId: connection.id, state: 'error', message: error.message, checkedAt: null });
      }
      for (const source of this.data.sources.filter(s => s.connectionId === connection.id && s.selected)) {
        const cache = this.cache(source.id);
        try {
          if (!client) throw new Error('Reconnect this account to refresh.');
          const items = await client.items(source.remote, start, end);
          const ids = new Set(items.map(item => item.id));
          cache.items = cache.items.filter(item => !ids.has(item.id) && !overlaps(item, start, end)).concat(items);
          const checkedAt = new Date().toISOString();
          cache.checks = [{ start, end, checkedAt }, ...cache.checks.filter(range => range.start !== start || range.end !== end)].slice(0, 30);
          health.push({ connectionId: connection.id, sourceId: source.id, state: 'current', checkedAt,
            message: source.provider === 'mac' || connection.route === 'mac' ? 'Checked the Mac calendar database.' : 'Checked the source.' });
        } catch (error) {
          const covered = cache.checks.find(range => range.start <= start && range.end >= end);
          health.push({ connectionId: connection.id, sourceId: source.id, state: covered ? 'stale' : 'error',
            checkedAt: covered?.checkedAt ?? null, message: error.message });
        }
      }
    }));
    this.profile.save();
    const sources = this.data.sources.map(({ remote, remoteId, ...source }) => source);
    const items = sources.filter(s => s.selected).flatMap(source => this.cache(source.id).items
      .filter(item => !item.completed && overlaps(item, start, end) && !this.data.hidden.some(h => matches(h, source.id, item.id)))
      .map(item => publicItem(item, source)));
    return {
      connectionOptions: { ...this.providers.connectionOptions,
        googleBrowser: Boolean(this.providers.connectionOptions?.googleBrowser || this.data.connections.some(c => c.provider === 'google' && c.route !== 'mac')) },
      connections: this.data.connections.map(({ id, provider, name, route }) => ({ id, provider, name, route })),
      sources, items, hidden: this.data.hidden, health, uncertain: this.data.journal
    };
  }

  hide({ sourceId, id }) {
    this.source(sourceId);
    const item = this.cache(sourceId).items.find(entry => entry.id === id);
    if (!item) throw new Error('Refresh the calendar and select the item again.');
    if (!this.data.hidden.some(entry => matches(entry, sourceId, id))) this.data.hidden.push({ sourceId, id, title: item.title });
    this.profile.save();
  }

  restore({ sourceId, id }) {
    this.data.hidden = this.data.hidden.filter(entry => !matches(entry, sourceId, id));
    this.profile.save();
  }

  acknowledge({ id }) {
    this.data.journal = this.data.journal.filter(entry => entry.id !== id);
    this.profile.save();
  }

  save(input) { return this.write(input.id ? 'update' : 'create', input); }
  complete(input) { return this.write('complete', input); }
  remove(input) { return this.write('remove', input); }

  async write(action, input) {
    const source = this.source(input.sourceId);
    if (!source.selected || !source.writable || source.readOnly) throw new Error('This calendar is read-only or unselected.');
    const connection = this.data.connections.find(entry => entry.id === source.connectionId);
    const client = this.client(connection);
    const cache = this.cache(source.id);
    const original = action === 'create' ? null : cache.items.find(item => item.id === input.id);
    if (action !== 'create') {
      if (!original || original.version !== input.version || original.completed) throw new Error('This item changed. Refresh and review it before saving.');
      const permission = { update: 'canEdit', complete: 'canComplete', remove: 'canDelete' }[action];
      if (!original[permission]) throw new Error('This action is unavailable for this item.');
      if (original.hasAttendees && !input.notify) throw new Error('Review the update to guests before saving.');
      if (original.recurring && !input.occurrence) throw new Error('Choose this occurrence before saving.');
    }
    if (typeof client[action] !== 'function') throw new Error('This calendar does not support that action.');
    const draft = action === 'create' || action === 'update' ? checkedDraft(input, source.provider) : undefined;
    const title = original?.title ?? draft?.title ?? '';
    if (this.data.journal.some(entry => entry.sourceId === source.id &&
      (original ? entry.targetId === original.id : entry.kind === 'create' && entry.title === title))) {
      throw new Error('An earlier change is unconfirmed. Check the source and review the change before trying again.');
    }
    const record = { id: randomUUID(), sourceId: source.id, connectionId: connection.id, targetId: original?.id,
      title, kind: action, startedAt: new Date().toISOString(), message: 'Check the source before repeating this change.' };
    this.data.journal.push(record);
    this.profile.save();
    let result;
    try {
      if (action === 'create') result = await client.create(source.remote, { ...draft, operationId: record.id });
      if (action === 'update') result = await client.update(source.remote, original, draft);
      if (action === 'complete') result = await client.complete(source.remote, original);
      if (action === 'remove') result = await client.remove(source.remote, original, { notify: input.notify, occurrence: input.occurrence });
    } catch (error) {
      if (error.code === 'UNCERTAIN') Object.assign(record, { message: error.message, providerId: error.providerId });
      else this.data.journal = this.data.journal.filter(entry => entry.id !== record.id);
      this.profile.save();
      throw error;
    }
    cache.items = cache.items.filter(item => item.id !== (original?.id ?? result?.id));
    if ((action === 'create' || action === 'update') && result?.id) cache.items.push(result);
    this.data.journal = this.data.journal.filter(entry => entry.id !== record.id);
    this.profile.save();
  }
}
