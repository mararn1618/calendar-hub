import { randomUUID } from 'node:crypto';
import { CalendarNotifications } from './calendar-notifications.mjs';
import { availableAccountName, legacyMacGoogle, splitMacGoogleConnection } from './account-connections.mjs';
import { applyTickTickCalendars, configureTickTickSettings, isTickTickInbox, listMetadata, orderedTickTickSources,
  publicTickTickSettings, retainTickTickFolders, tickTickSettings } from './ticktick-calendars.mjs';

const calendarDay = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = date => date.toISOString().slice(0, 10);
const key = (connectionId, remoteId) => JSON.stringify([connectionId, remoteId]);
const matches = (entry, sourceId, id) => entry.sourceId === sourceId && entry.id === id;
const currentTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const tickTickInboxId = sources => sources.find(source => isTickTickInbox(source) && source.id !== 'inbox')?.id;
const originalInboxItem = items => items?.find(item => item._ticktick?.projectId && item._ticktick.projectId !== 'inbox');
const preferenceCacheAge = 5 * 60_000;
const scheduleOf = ({ start, end, allDay }) => ({ start, end, allDay });

function currentHealth(source, connection, checkedAt) {
  return { connectionId: connection.id, sourceId: source.id, state: 'current', checkedAt,
    message: source.provider === 'mac' || connection.route === 'mac' ? 'Checked the Mac calendar database.' : 'Checked the source.' };
}

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

function rangeCheckedAt(checks, start, end, zone) {
  const ranges = checks.filter(check => check.zone === zone && check.checkedAt && check.start < end && check.end > start)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  let through = start;
  let oldest = null;
  while (through < end) {
    const latest = ranges.find(range => range.start <= through && range.end > through);
    if (!latest) return null;
    if (!oldest || latest.checkedAt < oldest) oldest = latest.checkedAt;
    through = latest.end;
  }
  return oldest;
}

function checkedDraft(input, itemKind) {
  const { start, end } = input;
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new Error('Enter a title.');
  if (input.allDay) {
    if (!isDay(start) || !isDay(end) || end <= start) throw new Error('Check the all-day dates.');
  } else {
    const first = Date.parse(start), last = Date.parse(end);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || (last === first && itemKind !== 'task')) {
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
    this.tickTickCalendars = new Map();
    this.activeWriteIds = new Set();
    this.queuedRefreshes = new Set();
    this.snapshotId = 0;
    this.notifications = new CalendarNotifications(this, providers.notificationCenter);
    this.queue = Promise.resolve();
    let migrated = false;
    for (const connection of this.data.connections.filter(entry => entry.provider === 'ticktick')) {
      if (!connection.ticktick) {
        connection.ticktick = tickTickSettings(connection.id, this.connectionSources(connection.id), this.data.unavailableSourceSettings);
        migrated = true;
      }
      this.applyTickTickSettings(connection);
    }
    if (migrated) this.profile.save();
  }

  run(operation, input = {}) {
    if (operation === 'connect') return this.connect(input);
    if (operation === 'macAccountCalendars') return this.macAccountCalendars(input);
    if (operation === 'macGoogleCalendars') return this.macAccountCalendars({ provider: 'google' }, true);
    if (operation === 'state') {
      const { start, end } = input;
      if (input.cachedOnly === true) return this.state(input);
      const zone = currentTimeZone();
      const preferencesOnly = input.preferencesOnly === true;
      const refreshNotifications = input.refreshNotifications === true;
      const pending = this.pendingState;
      if (pending && pending.start === start && pending.end === end && pending.zone === zone &&
          pending.preferencesOnly === preferencesOnly && pending.refreshNotifications === refreshNotifications) {
        return pending.result;
      }
      const result = this.enqueueRefresh(writtenItems => this.state(input, writtenItems));
      this.pendingState = { start, end, zone, preferencesOnly, refreshNotifications, result };
      const clear = () => { if (this.pendingState?.result === result) this.pendingState = null; };
      result.then(clear, clear);
      return result;
    }
    if (operation === 'refreshNotifications') return this.enqueueRefresh(writtenItems => this.notifications.refresh({ discover: true, writtenItems }));
    return this.enqueue(() => this[operation](input));
  }

  enqueueRefresh(work) {
    const writtenItems = new Map();
    this.queuedRefreshes.add(writtenItems);
    return this.enqueue(async () => {
      try { return await work(writtenItems); }
      finally { this.queuedRefreshes.delete(writtenItems); }
    });
  }

  enqueue(work) {
    this.pendingState = null;
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  async macAccountCalendars({ provider, connectionId }, allChosen = false) {
    const candidates = await this.providers.macAccountCalendars(provider);
    const accounts = this.data.connections.filter(entry => entry.provider === provider && entry.route === 'mac');
    const target = connectionId === undefined ? undefined : this.connection(connectionId, provider);
    if (target && target.route !== 'mac') throw new Error('Choose an account from Apple Calendar.');
    const selected = new Set(target && provider === 'google' ? this.profile.open(target).googleCalendarIds : []);
    if (allChosen) for (const account of accounts) for (const id of this.profile.open(account).googleCalendarIds) selected.add(id);
    const connected = new Set(accounts.map(account => account.accountId));
    for (const account of accounts.filter(legacyMacGoogle)) {
      const ids = new Set(this.profile.open(account).googleCalendarIds);
      for (const row of candidates) if (ids.has(row.id)) connected.add(row.accountId);
    }
    const rows = candidates.map(row => ({ ...row, connected: connected.has(row.accountId),
      chosen: provider === 'google' ? selected.has(row.id) && (!target?.accountId || target.accountId === row.accountId) :
        Boolean(target && row.accountId === target.accountId) }));
    const visible = new Set(candidates.filter(row => !target?.accountId || row.accountId === target.accountId).map(row => row.id));
    for (const id of selected) {
      if (!target || visible.has(id)) continue;
      const sourceId = key(target.id, id);
      const prior = this.data.sources.find(source => source.id === sourceId)?.remote ?? this.data.unavailableSourceSettings[sourceId];
      rows.push({ id, name: prior?.name || 'Unavailable calendar', accountId: target.accountId ?? prior?.accountId,
        accountName: prior?.accountName, writable: false, chosen: true, connected: true, unavailable: true });
    }
    return rows;
  }

  connection(id, provider) {
    const connection = this.data.connections.find(row => row.id === id && (!provider || row.provider === provider));
    if (!connection) throw new Error('This connection is unavailable. Open Calendars and choose a saved account.');
    return connection;
  }

  integration(provider) {
    return this.providers.connectionOptions?.integrations?.find(entry => entry.id === provider);
  }

  client(connection) {
    const timeZone = currentTimeZone();
    const cached = this.clients.get(connection.id);
    if (cached && cached.timeZone === timeZone) return cached.client;
    const client = this.providers.client(connection.provider, this.profile.open(connection));
    this.clients.set(connection.id, { client, timeZone });
    return client;
  }

  connectionSources(connectionId) {
    return this.data.sources.filter(source => source.connectionId === connectionId);
  }

  displayCalendars() {
    return [...this.tickTickCalendars.values()].flat().concat(this.data.sources.filter(source => source.provider !== 'ticktick')
      .map(source => ({ id: source.id, name: source.name, connectionId: source.connectionId, sourceIds: [source.id] })));
  }

  withCalendarColor(calendar) {
    const color = this.data.calendarColorOverrides?.[calendar.id];
    return color ? { ...calendar, color, hasCustomColor: true } : calendar;
  }

  setCalendarColor({ calendarId, color }) {
    if (!this.displayCalendars().some(calendar => calendar.id === calendarId)) throw new Error('Choose an available calendar.');
    if (color !== null && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) {
      throw new Error('Enter a six-digit hex color.');
    }
    const previous = this.data.calendarColorOverrides;
    const next = color?.toLowerCase();
    if (previous?.[calendarId] === next) return;
    this.data.calendarColorOverrides = { ...previous };
    if (next) this.data.calendarColorOverrides[calendarId] = next;
    else delete this.data.calendarColorOverrides[calendarId];
    try { this.profile.save(); }
    catch (error) { this.data.calendarColorOverrides = previous; throw error; }
  }

  removeCalendarPreferences(matches) {
    for (const preferences of [this.data.notificationPreferences, this.data.calendarColorOverrides]) {
      for (const id of Object.keys(preferences ?? {})) if (matches(id)) delete preferences[id];
    }
  }

  applyTickTickSettings(connection) {
    this.tickTickCalendars.set(connection.id, applyTickTickCalendars(connection, this.connectionSources(connection.id)));
  }

  updateSources(connection, discovered, selectNew = false) {
    const present = new Set();
    const unavailable = this.data.unavailableSourceSettings;
    const tickTick = connection.provider === 'ticktick';
    const readOnly = this.integration(connection.provider)?.readOnly === true;
    const previousSources = this.connectionSources(connection.id);
    const previousById = new Map(previousSources.map(source => [source.id, source]));
    const previousInbox = tickTick && previousSources.find(source => isTickTickInbox(source.remote));
    const discoveryOrder = [];
    if (tickTick) discovered = retainTickTickFolders(connection.id, previousSources, unavailable, discovered);
    for (let remote of discovered) {
      let id = key(connection.id, remote.id);
      if (previousInbox && isTickTickInbox(remote) && (remote.id === previousInbox.remoteId || remote.id === 'inbox' || previousInbox.remoteId === 'inbox')) {
        id = previousInbox.id;
        if (remote.id === 'inbox') remote = { ...remote, id: previousInbox.remoteId, inbox: true };
      }
      present.add(id);
      let source = previousById.get(id);
      const settings = source ?? unavailable[id];
      const details = {
        id, remoteId: remote.id, connectionId: connection.id, provider: connection.provider,
        name: remote.name, color: remote.color, writable: !readOnly && Boolean(remote.writable), remote
      };
      if (tickTick) {
        details.localReadOnly = settings?.localReadOnly ?? (settings?.readOnly === true && settings.writable !== false);
        details.readOnly = details.localReadOnly || !details.writable;
      }
      if (readOnly) details.readOnly = true;
      if (source) Object.assign(source, details);
      else {
        source = { ...details, selected: settings?.selected ?? selectNew, readOnly: details.readOnly ?? settings?.readOnly ?? !remote.writable };
        this.data.sources.push(source);
        delete unavailable[id];
      }
      if (tickTick) discoveryOrder.push(source);
    }
    this.data.sources = this.data.sources.filter(source => {
      if (source.connectionId !== connection.id || present.has(source.id)) return true;
      unavailable[source.id] = { selected: source.selected, readOnly: source.readOnly,
        ...(connection.provider === 'google' && connection.route === 'mac' &&
          { name: source.name, accountId: source.remote.accountId, accountName: source.remote.accountName }),
        ...(tickTick && { localReadOnly: source.localReadOnly ?? (source.readOnly && source.writable) }),
        ...(tickTick && source.remote.folder && { folder: source.remote.folder }) };
      return false;
    });
    if (tickTick) {
      const ordered = orderedTickTickSources(discoveryOrder);
      let index = 0;
      this.data.sources = this.data.sources.map(source => source.connectionId === connection.id ? ordered[index++] : source);
      this.applyTickTickSettings(connection);
    }
  }

  async connect(input) {
    const { provider, connectionId } = input;
    const target = connectionId === undefined ? undefined : this.connection(connectionId, provider);
    const previousSecret = target?.secret;
    const savedGoogleCalendarIds = target?.provider === 'google' && target.route === 'mac' ? this.profile.open(target).googleCalendarIds : [];
    if (provider === 'google' && input.route !== 'mac' && !input.clientId && !this.providers.connectionOptions?.googleBrowser) {
      const account = target ?? this.data.connections.find(entry => entry.provider === 'google' && entry.route !== 'mac');
      if (account) {
        const { clientId, clientSecret } = this.profile.open(account);
        if (clientId) input = { ...input, clientId, clientSecret };
      }
    }
    const secret = await this.providers.authorize(input, { legacyMac: Boolean(target && legacyMacGoogle(target)), savedGoogleCalendarIds });
    const timeZone = currentTimeZone();
    const client = this.providers.client(provider, secret);
    const discovered = await client.sources();
    if (secret.route === 'mac' && secret.googleCalendarIds?.some(id => !savedGoogleCalendarIds.includes(id) && !discovered.some(source => source.id === id))) {
      throw new Error('A chosen calendar is no longer available. Check your Google calendars in Apple Calendar and choose again.');
    }
    const accountKey = this.providers.identity(provider, secret, discovered);
    let inboxId;
    if (provider === 'ticktick') {
      inboxId = tickTickInboxId(discovered);
      if (!inboxId && client.accountInboxId) {
        const prior = target && this.previousTickTickInbox(target);
        const today = new Intl.DateTimeFormat('sv-SE', { timeZone }).format(new Date());
        for (const day of new Set([prior?.day ?? today, today])) {
          try { inboxId = await client.accountInboxId(day, prior?.id); }
          catch (error) {
            if (error.code === 'AUTH_REQUIRED') throw error;
            break;
          }
          if (inboxId) break;
        }
      }
    }
    return this.enqueue(() => this.storeConnection({ input, secret, client, discovered, accountKey, timeZone, previousSecret, inboxId }));
  }

  tickTickConnection(provider, id) {
    const connection = provider === 'ticktick' && this.data.connections.find(entry => entry.provider === provider && entry.id === id);
    if (!connection) throw new Error('This TickTick connection is unavailable. Open Calendars and choose a saved account.');
    return connection;
  }

  previousTickTickInbox(connection) {
    const source = this.connectionSources(connection.id).find(source => isTickTickInbox(source.remote));
    const item = originalInboxItem(this.data.cache[source?.id]?.items);
    const day = item?.allDay ? item.start : item && new Intl.DateTimeFormat('sv-SE').format(new Date(item.start));
    return { id: connection.tickTickInboxId || (source?.remoteId !== 'inbox' && source?.remoteId) || item?._ticktick.projectId, day };
  }

  storeConnection({ input, secret, client, discovered, accountKey, timeZone, previousSecret, inboxId }) {
    const { provider, connectionId } = input;
    const accounts = this.data.connections.filter(entry => entry.provider === provider);
    let existing = accounts.find(entry => entry.accountKey === accountKey);
    const target = connectionId === undefined ? undefined : this.connection(connectionId, provider);
    const providerName = this.integration(provider)?.name ?? provider;
    if (!existing && inboxId) existing = accounts.find(account => this.previousTickTickInbox(account).id === inboxId);
    if (target) {
      if (target.secret !== previousSecret) throw new Error('This connection changed during sign-in. Open Calendars and try again.');
      if (existing && existing !== target) throw new Error('This account is already connected to another saved connection.');
      if (!existing) {
        if (provider === 'ticktick') {
          throw new Error('Calendar Hub could not verify the Inbox for this saved connection. Sign in with the same TickTick account, or add a separate connection.');
        }
        if (provider !== 'google' || target.route === 'mac' || secret.route === 'mac' ||
            !this.connectionSources(target.id).some(source => source.remote.primary && source.remoteId === accountKey)) {
          throw new Error('Sign in with the same account to reconnect, or add a separate connection.');
        }
      }
    }
    if (secret.route === 'mac' && existing && !target) throw new Error('This account is already connected. Choose it in Manage calendars.');
    if (provider === 'google' && secret.route === 'mac') {
      const chosen = new Set(secret.googleCalendarIds);
      const conflict = accounts.some(account => account !== target && account.route === 'mac' && (legacyMacGoogle(account)
        ? this.profile.open(account).googleCalendarIds.some(id => chosen.has(id))
        : discovered.some(row => row.accountId === account.accountId)));
      if (conflict) throw new Error('This account is already connected. Choose it in Manage calendars.');
    }
    let connection = target ?? existing;
    const primary = discovered.find(source => source.primary);
    const base = (typeof input.name === 'string' && input.name.trim()) || (secret.accountId && discovered[0]?.accountName) ||
      (primary?.id?.includes('@') ? primary.id : primary?.name) || providerName;
    const name = connection?.name || availableAccountName(base, accounts, provider);
    const encrypted = this.profile.seal(secret);
    if (!connection) {
      connection = { id: randomUUID(), provider, accountKey, name, secret: encrypted };
      if (provider === 'ticktick') connection.ticktick = tickTickSettings(connection.id, [], {}, true);
      this.data.connections.push(connection);
    } else Object.assign(connection, { accountKey, name, secret: encrypted });
    if (inboxId) connection.tickTickInboxId = inboxId;
    if (secret.route === 'mac') {
      connection.route = 'mac';
      if (secret.accountId) connection.accountId = secret.accountId;
    }
    this.clients.set(connection.id, { client, timeZone });
    this.updateSources(connection, discovered, secret.route === 'mac');
    this.profile.save();
    return this.notifications.refresh({ read: 'changed' });
  }

  renameConnection({ connectionId, name }) {
    const connection = this.connection(connectionId);
    const label = typeof name === 'string' && name.trim();
    if (!label) throw new Error('Enter an account name.');
    if (availableAccountName(label, this.data.connections, connection.provider, connectionId) !== label) {
      throw new Error('Another account already uses that name.');
    }
    connection.name = label;
    if (connection.provider === 'ticktick') this.applyTickTickSettings(connection);
    this.profile.save();
    return this.notifications.refresh({ read: 'none' });
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
    this.tickTickCalendars.delete(connectionId);
    this.removeCalendarPreferences(belongs);
    this.profile.save();
    return this.notifications.refresh({ read: 'none' });
  }

  setSource({ sourceId, selected, readOnly }) {
    const source = this.source(sourceId);
    if (typeof selected === 'boolean') {
      if (source.provider === 'ticktick') {
        if (selected !== source.included) {
          const connection = this.tickTickConnection('ticktick', source.connectionId);
          const included = new Set(connection.ticktick.includedSourceIds ?? this.connectionSources(connection.id)
            .filter(entry => entry.included).map(entry => entry.id));
          if (selected) included.add(sourceId);
          else included.delete(sourceId);
          connection.ticktick.includedSourceIds = [...included];
          this.applyTickTickSettings(connection);
        }
      } else source.selected = selected;
    }
    if (typeof readOnly === 'boolean') {
      if (source.provider === 'ticktick') source.localReadOnly = readOnly;
      source.readOnly = !source.writable || readOnly;
    }
    this.profile.save();
    if (source.provider === 'ticktick' && typeof selected === 'boolean') return this.notifications.refresh({ read: 'changed' });
  }

  configureTickTick(input) {
    const connection = this.tickTickConnection('ticktick', input.connectionId);
    const sources = this.connectionSources(connection.id);
    connection.ticktick = configureTickTickSettings(connection.ticktick, input, sources.map(source => source.id), this.data.unavailableSourceSettings);
    if (input.groups !== undefined) {
      this.removeCalendarPreferences(id => {
        const [account, kind, groupId] = JSON.parse(id);
        return account === connection.id && kind === 'custom' && !connection.ticktick.groups.some(group => group.id === groupId);
      });
    }
    this.applyTickTickSettings(connection);
    this.profile.save();
    return this.notifications.refresh({ read: 'changed' });
  }

  setCalendarNotifications(input) { return this.notifications.set(input); }

  setTickTickCalendarVisible({ connectionId, calendarId, visible }) {
    const connection = this.tickTickConnection('ticktick', connectionId);
    if (typeof visible !== 'boolean' || !this.tickTickCalendars.get(connectionId).some(calendar => calendar.id === calendarId)) {
      throw new Error('Choose an available calendar from this TickTick account.');
    }
    const hidden = new Set(connection.ticktick.hiddenCalendarIds);
    if (visible) hidden.delete(calendarId);
    else hidden.add(calendarId);
    connection.ticktick.hiddenCalendarIds = [...hidden];
    this.applyTickTickSettings(connection);
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

  preferenceHealth(source, connection, range) {
    const last = range.checks.get(source.id);
    if (last) {
      if (range.visible.has(source.id) || Date.now() - last.at < preferenceCacheAge) return last.health;
      return;
    }
    const covered = this.data.cache[source.id]?.checks.find(check => check.zone === range.zone && check.start <= range.start &&
      check.end >= range.end && Date.now() - Date.parse(check.checkedAt) < preferenceCacheAge);
    if (covered) {
      const health = currentHealth(source, connection, covered.checkedAt);
      range.checks.set(source.id, { health, at: Date.parse(covered.checkedAt) });
      return health;
    }
  }

  async refreshConnection(connection, range, preferencesOnly) {
    let client;
    const connectionError = error => range.discoveryErrors.set(connection.id,
      { connectionId: connection.id, state: 'error', message: error.message, checkedAt: null });
    if (!preferencesOnly) {
      try {
        client = this.client(connection);
        this.updateSources(connection, await client.sources());
        range.discoveryErrors.delete(connection.id);
      } catch (error) { connectionError(error); }
    }
    const sources = this.connectionSources(connection.id).filter(source => source.selected);
    const checks = sources.map(source => preferencesOnly ? this.preferenceHealth(source, connection, range) : undefined);
    if (preferencesOnly && checks.some(check => !check)) {
      try { client = this.client(connection); }
      catch (error) { connectionError(error); }
    }
    const remaining = sources.entries();
    const worker = async () => {
      for (const [index, source] of remaining) {
        if (checks[index]) continue;
        const health = await this.refreshSource(source, connection, client, range);
        checks[index] = health;
        range.checks.set(source.id, { health, at: Date.now() });
      }
    };
    const limit = connection.provider === 'ticktick' ? 4 : 1;
    await Promise.all(Array.from({ length: Math.min(limit, sources.length) }, worker));
    const error = range.discoveryErrors.get(connection.id);
    return error ? [error, ...checks] : checks;
  }

  async refreshSource(source, connection, client, { start, end, zone, writtenItems }) {
    const cache = this.cache(source.id);
    try {
      if (!client) throw new Error('Reconnect this account to refresh.');
      const fetched = await client.items(source.remote, start, end);
      const preserved = writtenItems?.get(source.id);
      const items = preserved ? fetched.filter(item => !preserved.has(item.id)) : fetched;
      if (source.provider === 'ticktick' && !connection.tickTickInboxId && isTickTickInbox(source.remote)) {
        const item = originalInboxItem(items);
        if (item) connection.tickTickInboxId = item._ticktick.projectId;
      }
      const ids = new Set(items.map(item => item.id));
      cache.items = cache.items.filter(item => preserved?.has(item.id) || !ids.has(item.id) && !overlaps(item, start, end)).concat(items);
      this.notifications.observeTickTickItems(source, items);
      const checkedAt = new Date().toISOString();
      cache.checks = [{ start, end, zone, checkedAt }, ...cache.checks.filter(range => range.start !== start || range.end !== end)].slice(0, 30);
      return currentHealth(source, connection, checkedAt);
    } catch (error) {
      const checkedAt = rangeCheckedAt(cache.checks, start, end, zone);
      return { connectionId: connection.id, sourceId: source.id, state: checkedAt ? 'stale' : 'error',
        checkedAt, message: error.message };
    }
  }

  async state({ start, end, cachedOnly = false, preferencesOnly = false, refreshNotifications = false }, writtenItems) {
    validateRange(start, end);
    if (cachedOnly === true) return this.cachedState(start, end);
    const legacy = this.data.connections.find(legacyMacGoogle);
    if (legacy && !preferencesOnly) {
      try {
        const inventory = await this.providers.macAccountCalendars('google', { requestAccess: false });
        const changed = splitMacGoogleConnection(this.profile, this.providers, legacy, inventory);
        if (changed) {
          for (const id of changed) this.clients.delete(id);
          this.lastRange = null;
        }
      } catch {
        // The saved connection remains usable while account discovery or the keychain is unavailable.
      }
    }
    const zone = currentTimeZone();
    if (this.lastRange?.start !== start || this.lastRange.end !== end || this.lastRange.zone !== zone) {
      this.lastRange = { start, end, zone, checks: new Map(), discoveryErrors: new Map(), visible: new Set() };
    }
    const range = this.lastRange;
    const health = (await Promise.all(this.data.connections.map(connection =>
      this.refreshConnection(connection, { ...range, writtenItems }, preferencesOnly === true)))).flat();
    await this.notifications.refresh({ read: refreshNotifications ? 'all' : preferencesOnly ? 'none' : 'changed',
      checkedRange: preferencesOnly ? undefined : { start, end, health }, writtenItems });
    this.profile.save();
    range.visible = new Set(this.data.sources.filter(source => source.selected).map(source => source.id));
    return this.cachedState(start, end, health);
  }

  cachedHealth(start, end, zone) {
    const range = this.lastRange;
    if (range?.start !== start || range.end !== end || range.zone !== zone) return [];
    return this.data.connections.flatMap(connection => {
      const error = range.discoveryErrors.get(connection.id);
      const checks = this.connectionSources(connection.id).filter(source => source.selected)
        .map(source => range.checks.get(source.id)?.health).filter(Boolean);
      return error ? [error, ...checks] : checks;
    });
  }

  cachedState(start, end, health) {
    const zone = currentTimeZone();
    const legacyIds = new Set(this.data.connections.filter(legacyMacGoogle).map(row => row.id));
    const sources = this.data.sources.map(({ remote, remoteId, localReadOnly, ...source }) => {
      source.itemKind = this.integration(source.provider)?.itemKind ?? (source.provider === 'ticktick' ? 'task' : 'event');
      if (source.provider === 'ticktick') return { ...source, ...listMetadata(remote) };
      if (source.provider === 'mac' || legacyIds.has(source.connectionId)) {
        source.nativeAccountId = remote.accountId;
        source.nativeAccountName = remote.accountName;
      }
      return this.withCalendarColor(source);
    });
    const selected = sources.filter(source => source.selected);
    const rangeCovered = selected.every(source => rangeCheckedAt(this.data.cache[source.id]?.checks ?? [], start, end, zone) !== null);
    const items = selected.flatMap(source => (this.data.cache[source.id]?.items ?? [])
      .filter(item => !item.completed && !item.movedToSourceId && overlaps(item, start, end) && !this.data.hidden.some(h => matches(h, source.id, item.id)))
      .map(item => publicItem(item, source)));
    const options = this.providers.connectionOptions ?? {};
    const googleBrowser = Boolean(options.googleBrowser || this.data.connections.some(c => c.provider === 'google' && c.route !== 'mac'));
    const integrations = options.integrations?.map(entry => entry.id === 'google' && googleBrowser && !entry.routes.includes('browser')
      ? { ...entry, routes: ['browser', ...entry.routes] } : entry);
    return {
      connectionOptions: { ...options, googleBrowser, integrations },
      connections: this.data.connections.map(connection => {
        const { id, provider, name, route, accountId, ticktick } = connection;
        return { id, provider, name, route, ...(accountId && { accountId }), ...(legacyMacGoogle(connection) && { legacyMac: true }),
          ...(ticktick && { ticktick: publicTickTickSettings(ticktick) }) };
      }),
      ticktickCalendars: this.data.connections.flatMap(connection => this.tickTickCalendars.get(connection.id) ?? [])
        .map(calendar => this.withCalendarColor(calendar)),
      notificationPreferences: this.notifications.preferences(), notificationError: this.notifications.error,
      snapshotId: ++this.snapshotId, sources, items, rangeCovered, hidden: this.data.hidden,
      health: health ?? this.cachedHealth(start, end, zone),
      uncertain: this.data.journal.filter(entry => !this.activeWriteIds.has(entry.id))
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

  async acknowledge({ id }) {
    const record = this.data.journal.find(entry => entry.id === id);
    this.data.journal = this.data.journal.filter(entry => entry.id !== id);
    this.profile.save();
    const source = this.data.sources.find(entry => entry.id === record?.sourceId);
    if (source && this.lastRange) {
      const connection = this.connection(source.connectionId);
      await this.reconcileSource(source, connection);
      this.profile.save();
      await this.notifications.refresh({ read: 'none' });
    }
  }

  save(input) { return this.write(input.id ? 'update' : 'create', input); }
  complete(input) { return this.write('complete', input); }
  remove(input) { return this.write('remove', input); }

  preserveForQueuedRefreshes(sourceId, ...ids) {
    for (const writtenItems of this.queuedRefreshes) {
      const preserved = writtenItems.get(sourceId) ?? new Set();
      for (const id of ids) if (id) preserved.add(id);
      writtenItems.set(sourceId, preserved);
    }
  }

  replaceCachedItem(source, original, item) {
    const cache = this.cache(source.id);
    cache.items = cache.items.filter(entry => entry.id !== original?.id && entry.id !== item?.id);
    if (item?.id) cache.items.push(item);
    if (item || original) this.notifications.observeTickTickItems(source, [item ?? original]);
  }

  async reconcileSource(source, connection, client) {
    const range = this.lastRange;
    if (!client) {
      try { client = this.client(connection); }
      catch { /* refreshSource keeps the cached range when the account is unavailable. */ }
    }
    const health = await this.refreshSource(source, connection, client, range);
    range.checks.set(source.id, { health, at: Date.now() });
  }

  async reconcileWriteError(error, source, connection, client, original) {
    if (error.code !== 'CONFLICT' && error.code !== 'UNCERTAIN') return;
    const checkedItem = original && Object.hasOwn(error, 'currentItem');
    if (checkedItem) {
      this.replaceCachedItem(source, original, error.currentItem);
    } else {
      if (!this.lastRange) return;
      await this.reconcileSource(source, connection, client);
    }
    this.profile.save();
    await this.notifications.refresh({ read: 'none' });
    if (checkedItem) this.preserveForQueuedRefreshes(source.id, original.id);
  }

  async write(action, input) {
    const view = input.viewRange;
    if (view) validateRange(view.start, view.end);
    const source = this.source(input.sourceId);
    const integration = this.integration(source.provider);
    if (!source.selected || !source.writable || source.readOnly || integration?.readOnly) throw new Error('This calendar is read-only or unselected.');
    const connection = this.data.connections.find(entry => entry.id === source.connectionId);
    const client = this.client(connection);
    const cache = this.cache(source.id);
    const original = action === 'create' ? null : cache.items.find(item => item.id === input.id);
    if (action !== 'create') {
      if (!original || original.version !== input.version || original.completed) {
        throw Object.assign(new Error('This item changed. Review it before saving.'), { code: 'CONFLICT' });
      }
      const permission = { update: 'canEdit', complete: 'canComplete', remove: 'canDelete' }[action];
      if (!original[permission]) throw new Error('This action is unavailable for this item.');
      if (original.hasAttendees && !input.notify) throw new Error('Review the update to guests before saving.');
      if (original.recurring && !input.occurrence) throw new Error('Choose this occurrence before saving.');
    }
    if (typeof client[action] !== 'function') throw new Error('This calendar does not support that action.');
    const itemKind = integration?.itemKind ?? (source.provider === 'ticktick' ? 'task' : 'event');
    const draft = action === 'create' || action === 'update' ? checkedDraft(input, itemKind) : undefined;
    const title = original?.title ?? draft?.title ?? '';
    if (this.data.journal.some(entry => entry.sourceId === source.id &&
      (original ? entry.targetId === original.id : entry.kind === 'create' && entry.title === title))) {
      throw new Error('An earlier change is unconfirmed. Check the source and review the change before trying again.');
    }
    const record = { id: randomUUID(), sourceId: source.id, connectionId: connection.id, targetId: original?.id,
      title, kind: action, startedAt: new Date().toISOString(), message: 'Check the source before repeating this change.' };
    if (action === 'update' && (original.allDay !== draft.allDay || Date.parse(original.start) !== Date.parse(draft.start) ||
        Date.parse(original.end) !== Date.parse(draft.end))) {
      record.originalSchedule = scheduleOf(original);
      record.proposedSchedule = scheduleOf(draft);
    }
    this.data.journal.push(record);
    this.profile.save();
    let result;
    this.activeWriteIds.add(record.id);
    try {
      if (action === 'create') result = await client.create(source.remote, { ...draft, operationId: record.id });
      if (action === 'update') result = await client.update(source.remote, original, draft);
      if (action === 'complete') result = await client.complete(source.remote, original);
      if (action === 'remove') result = await client.remove(source.remote, original, { notify: input.notify, occurrence: input.occurrence });
    } catch (error) {
      if (error.code === 'UNCERTAIN') Object.assign(record, { message: error.message, providerId: error.providerId });
      else this.data.journal = this.data.journal.filter(entry => entry.id !== record.id);
      this.profile.save();
      await this.reconcileWriteError(error, source, connection, client, original);
      throw error;
    } finally {
      this.activeWriteIds.delete(record.id);
    }
    const saved = action === 'create' || action === 'update' ? result : null;
    this.replaceCachedItem(source, original, saved);
    this.data.journal = this.data.journal.filter(entry => entry.id !== record.id);
    this.profile.save();
    await this.notifications.refresh({ read: 'none' });
    this.preserveForQueuedRefreshes(source.id, original?.id, result?.id);
    if (view) return { state: this.cachedState(view.start, view.end), item: saved?.id ? publicItem(saved, source) : null };
  }
}
