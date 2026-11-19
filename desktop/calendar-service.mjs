import { randomUUID } from 'node:crypto';
import { CalendarNotifications } from './calendar-notifications.mjs';
import { failedCheck, usesMacCalendars } from './sync-health.mjs';
import { recordTickTickRateLimit, tickTickCooldown } from './providers/ticktick-rate-limit.mjs';
import { defaultSyncMinutes, inventoryFreshness, outsideWindow, planTickTickReads, recentlyChecked, recentTaskChecks, retryTime,
  tickTickSyncMinutes } from './ticktick-ranges.mjs';
import { availableAccountName, legacyMacGoogle, splitMacGoogleConnection } from './account-connections.mjs';
import { applyTickTickCalendars, configureTickTickSettings, isTickTickInbox, listMetadata, orderedTickTickSources,
  publicTickTickSettings, retainTickTickFolders, tickTickSettings } from './ticktick-calendars.mjs';

const calendarDay = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = date => date.toISOString().slice(0, 10);
const key = (connectionId, remoteId) => JSON.stringify([connectionId, remoteId]);
const sameHiddenItem = (entry, sourceId, item) => entry.sourceId === sourceId && (
  entry.visibilityId && item.visibilityId ? entry.visibilityId === item.visibilityId : entry.id === item.id);
const currentTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const tickTickInboxId = sources => sources.find(source => isTickTickInbox(source) && source.id !== 'inbox')?.id;
const originalInboxItem = items => items?.find(item => item._ticktick?.projectId && item._ticktick.projectId !== 'inbox');
const preferenceCacheAge = 5 * 60_000;
const scheduleOf = ({ start, end, allDay }) => ({ start, end, allDay });

function currentHealth(source, connection, checkedAt) {
  return { connectionId: connection.id, sourceId: source.id, state: 'current', checkedAt,
    message: usesMacCalendars(connection) ? 'Checked the Mac calendar database.' : 'Checked the source.' };
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

const tickTickReadCycle = () => ({ checked: new Map(), failures: new Map(), limited: new Map() });
const failedWindow = (cache, start, end, zone) => cache?.tickTickFailures?.find(failure =>
  failure.zone === zone && failure.start < end && failure.end > start);

function publicRequestStats(stats = {}) {
  const operations = ['lists', 'folders', 'datedTasks', 'list', 'listTasks', 'task',
    'createTask', 'updateTask', 'completeTask', 'completeInboxTask'];
  return Object.fromEntries(operations.filter(key => Number.isSafeInteger(stats?.[key]?.count)).map(key => {
    const { count, lastAt, lastStatus, lastLimitedAt, lastRetryAt } = stats[key];
    return [key, { count, lastAt: Number.isFinite(lastAt) ? lastAt : null, lastStatus: Number.isInteger(lastStatus) ? lastStatus : null,
      ...(Number.isFinite(lastLimitedAt) && Number.isFinite(lastRetryAt) && { lastLimitedAt, lastRetryAt }) }];
  }));
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
    ...(item.visibilityId && { visibilityId: item.visibilityId }),
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
    if (operation === 'hide' || operation === 'restore') return Promise.resolve().then(() => this[operation](input));
    if (operation === 'macAccountCalendars') return this.macAccountCalendars(input);
    if (operation === 'macGoogleCalendars') return this.macAccountCalendars({ provider: 'google' }, true);
    if (operation === 'state') {
      const { start, end } = input;
      if (input.cachedOnly === true) return this.state(input);
      const zone = currentTimeZone();
      const preferencesOnly = input.preferencesOnly === true;
      const refreshNotifications = input.refreshNotifications === true;
      const macOnly = input.macOnly === true;
      const tickTickOnly = input.tickTickOnly === true;
      const forceRefresh = input.forceRefresh ?? (!preferencesOnly && !tickTickOnly);
      const pending = this.pendingState;
      if (pending && pending.start === start && pending.end === end && pending.zone === zone &&
          pending.preferencesOnly === preferencesOnly && pending.refreshNotifications === refreshNotifications &&
          pending.macOnly === macOnly && pending.tickTickOnly === tickTickOnly && pending.forceRefresh === forceRefresh) {
        return pending.result;
      }
      const result = this.enqueueRefresh(writtenItems => this.state(input, writtenItems));
      this.pendingState = { start, end, zone, preferencesOnly, refreshNotifications, macOnly, tickTickOnly, forceRefresh, result };
      const clear = () => { if (this.pendingState?.result === result) this.pendingState = null; };
      result.then(clear, clear);
      return result;
    }
    if (operation === 'refreshNotifications') return this.enqueueRefresh(writtenItems => this.notifications.refresh({
      discover: true, writtenItems, tickTickOnly: input.tickTickOnly === true }));
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

  async macAccountCalendars({ provider, connectionId, requestAccess = true }, allChosen = false) {
    const candidates = await this.providers.macAccountCalendars(provider, { requestAccess });
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

  tickTickClientOptions(connection) {
    return {
      rateLimit: connection.tickTickRateLimit ??= {},
      requestStats: connection.tickTickRequestStats ??= {},
      onRateLimitChange: () => this.saveTickTickLimit(connection),
      inboxProjectId: connection.tickTickInboxId,
    };
  }

  saveTickTickLimit(connection) {
    if (connection.pendingCredentialKey) {
      const pending = this.data.pendingTickTickLimits ??= {};
      for (const [key, limit] of Object.entries(pending)) {
        if (!(limit.retryAt > Date.now() - 3_600_000)) delete pending[key];
      }
      const limit = connection.tickTickRateLimit;
      if (limit.retryAt) pending[connection.pendingCredentialKey] = limit;
      else delete pending[connection.pendingCredentialKey];
    }
    this.profile.save();
  }

  requestError(connection, error) {
    if (connection.provider !== 'ticktick' || error.code === 'UNCERTAIN' || (error.status !== 429 && error.code !== 'RATE_LIMITED')) return error;
    const state = connection.tickTickRateLimit ??= {};
    if (Number.isFinite(error.retryAt) && error.retryAt === state.retryAt) return error;
    const blocked = tickTickCooldown(state);
    if (blocked) return blocked;
    const delay = Number.isFinite(error.retryAt) ? String(Math.max(0, Math.ceil((error.retryAt - Date.now()) / 1000))) : undefined;
    const limited = recordTickTickRateLimit(state, delay);
    this.saveTickTickLimit(connection);
    return limited;
  }

  client(connection) {
    const timeZone = currentTimeZone();
    const cached = this.clients.get(connection.id);
    if (cached && cached.timeZone === timeZone) return cached.client;
    const options = connection.provider === 'ticktick' ? this.tickTickClientOptions(connection) : undefined;
    const client = this.providers.client(connection.provider, this.profile.open(connection), options);
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
    for (const preferences of [this.data.notificationPreferences, this.data.calendarColorOverrides, this.data.tickTickSyncIntervals]) {
      for (const id of Object.keys(preferences ?? {})) if (matches(id)) delete preferences[id];
    }
  }

  syncMinutes(calendarId) {
    const minutes = this.data.tickTickSyncIntervals?.[calendarId];
    return tickTickSyncMinutes.includes(minutes) ? minutes : defaultSyncMinutes;
  }

  nextTickTickNotificationCheckAt() {
    return this.notifications.nextTickTickCheckAt();
  }

  tickTickSourceCheckAt(source, { start, end, zone }, now) {
    const cache = this.data.cache[source.id];
    const minutes = this.syncMinutes(source.calendarId);
    let due = Infinity;
    let ranges = [{ start, end, zone }];
    for (const failed of cache?.tickTickFailures ?? []) {
      if (failed.zone !== zone || failed.start >= end || failed.end <= start) continue;
      if (minutes) due = Math.min(due, retryTime(failed, minutes));
      ranges = outsideWindow(ranges, failed);
    }
    for (const part of ranges) {
      const checked = Date.parse(rangeCheckedAt(cache?.checks ?? [], part.start, part.end, zone));
      if (!Number.isFinite(checked) || checked > now) return now;
      if (minutes) due = Math.min(due, checked + minutes * 60_000);
    }
    return due;
  }

  nextTickTickRefreshAt(start, end, zone) {
    const now = Date.now();
    const deadlines = [];
    for (const connection of this.data.connections.filter(entry => entry.provider === 'ticktick')) {
      for (const source of this.connectionSources(connection.id)) {
        const minutes = this.syncMinutes(source.calendarId);
        if (!source.selected || !minutes) continue;
        if (connection.tickTickRateLimit?.retryAt > now) {
          deadlines.push(connection.tickTickRateLimit.retryAt);
          continue;
        }
        deadlines.push(this.tickTickSourceCheckAt(source, { start, end, zone }, now));
      }
    }
    return deadlines.length ? Math.max(now, Math.min(...deadlines)) : null;
  }

  setTickTickSyncInterval({ calendarId, minutes }) {
    if (![...this.tickTickCalendars.values()].some(calendars => calendars.some(entry => entry.id === calendarId))) {
      throw new Error('Choose an available TickTick calendar.');
    }
    if (!tickTickSyncMinutes.includes(minutes)) throw new Error('Choose a supported TickTick refresh interval.');
    if (this.syncMinutes(calendarId) === minutes) return;
    const previous = this.data.tickTickSyncIntervals;
    this.data.tickTickSyncIntervals = { ...previous };
    if (minutes === defaultSyncMinutes) delete this.data.tickTickSyncIntervals[calendarId];
    else this.data.tickTickSyncIntervals[calendarId] = minutes;
    try { this.profile.save(); }
    catch (error) { this.data.tickTickSyncIntervals = previous; throw error; }
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
    const blocked = tickTickCooldown(target?.tickTickRateLimit);
    if (blocked) throw blocked;
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
    return this.enqueue(() => this.discoverConnection(input, secret, previousSecret, savedGoogleCalendarIds));
  }

  async discoverConnection(input, secret, previousSecret, savedGoogleCalendarIds) {
    const { provider, connectionId } = input;
    const target = connectionId === undefined ? undefined : this.connection(connectionId, provider);
    if (target && target.secret !== previousSecret) throw new Error('This connection changed during sign-in. Open Calendars and try again.');
    const timeZone = currentTimeZone();
    let account = target;
    let options;
    if (provider === 'ticktick') {
      const key = this.providers.credentialIdentity?.(provider, secret);
      const known = key && this.data.connections.find(connection => connection.provider === provider && connection.accountKey === key);
      if (target && known && known !== target) throw new Error('This account is already connected to another saved connection.');
      account = known ?? target ?? { provider, pendingCredentialKey: key, tickTickRateLimit: this.data.pendingTickTickLimits?.[key] };
      const blocked = tickTickCooldown(account.tickTickRateLimit);
      if (blocked) throw blocked;
      options = { ...this.tickTickClientOptions(account), inboxProjectId: undefined };
    }
    const client = this.providers.client(provider, secret, options);
    let discovered;
    try { discovered = await client.sources(); }
    catch (error) { throw account ? this.requestError(account, error) : error; }
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
            if (error.code === 'AUTH_REQUIRED' || error.code === 'RATE_LIMITED' || error.status === 429) throw this.requestError(account, error);
            break;
          }
          if (inboxId) break;
        }
      }
    }
    return this.storeConnection({ input, secret, client, discovered, accountKey, timeZone, previousSecret, inboxId, account });
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

  storeConnection({ input, secret, client, discovered, accountKey, timeZone, previousSecret, inboxId, account }) {
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
    if (provider === 'ticktick') {
      connection.tickTickSourcesCheckedAt = Date.now();
      connection.tickTickRateLimit ??= account.tickTickRateLimit;
      connection.tickTickRequestStats ??= account.tickTickRequestStats;
      if (account.pendingCredentialKey) {
        delete this.data.pendingTickTickLimits?.[account.pendingCredentialKey];
        delete account.pendingCredentialKey;
      }
    }
    if (secret.route === 'mac') {
      connection.route = 'mac';
      if (secret.accountId) connection.accountId = secret.accountId;
    }
    if (provider === 'ticktick' && account.tickTickRateLimit !== connection.tickTickRateLimit) this.clients.delete(connection.id);
    else this.clients.set(connection.id, { client, timeZone });
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

  rememberTickTickFailure(source, connection, { start, end, zone }, reason) {
    const cache = this.cache(source.id);
    const failed = { start, end, zone, at: Date.now(), error: failedCheck(connection.id, reason) };
    cache.tickTickFailures = [failed, ...outsideWindow(cache.tickTickFailures ?? [], failed)].slice(0, 96);
  }

  preferenceHealth(source, connection, range) {
    const last = range.checks.get(source.id);
    if (last) {
      if (range.visible.has(source.id) || Date.now() - last.at < preferenceCacheAge) return last.health;
      return;
    }
    const cache = this.data.cache[source.id];
    if (failedWindow(cache, range.start, range.end, range.zone)) return;
    const covered = cache?.checks.find(check => check.zone === range.zone && check.start <= range.start &&
      check.end >= range.end && Date.now() - Date.parse(check.checkedAt) < preferenceCacheAge);
    if (covered) {
      const health = currentHealth(source, connection, covered.checkedAt);
      range.checks.set(source.id, { health, at: Date.parse(covered.checkedAt) });
      return health;
    }
  }

  async discoverSources(connection, force = false, automatic = true) {
    const blocked = tickTickCooldown(connection.tickTickRateLimit);
    if (blocked) throw blocked;
    const tickTick = connection.provider === 'ticktick';
    if (tickTick && !force && (!automatic || recentlyChecked(connection.tickTickSourcesCheckedAt, inventoryFreshness))) return;
    try {
      const client = this.client(connection);
      this.updateSources(connection, await client.sources());
      if (tickTick) connection.tickTickSourcesCheckedAt = Date.now();
      return client;
    } catch (error) {
      if (tickTick) delete connection.tickTickSourcesCheckedAt;
      throw this.requestError(connection, error);
    }
  }

  clientForReads(connection, jobs, force) {
    if (connection.provider === 'ticktick') {
      const now = Date.now();
      if (tickTickCooldown(connection.tickTickRateLimit, now) ||
          !force && jobs.every(job => this.tickTickSourceCheckAt(job.source, job, now) > now)) {
        const cached = this.clients.get(connection.id);
        return cached?.timeZone === currentTimeZone() ? cached.client : undefined;
      }
    }
    return this.client(connection);
  }

  async refreshConnection(connection, range, preferencesOnly, forceRefresh) {
    let client;
    let failure;
    if (range.tickTickOnly && !this.connectionSources(connection.id).some(source => source.selected && this.syncMinutes(source.calendarId) > 0)) return;
    if (!preferencesOnly) {
      try {
        const automatic = this.connectionSources(connection.id).some(source => source.selected && this.syncMinutes(source.calendarId) > 0);
        client = await this.discoverSources(connection, forceRefresh, automatic);
        range.discoveryErrors.delete(connection.id);
      } catch (error) {
        failure = error;
        range.discoveryErrors.set(connection.id, failedCheck(connection.id, error));
      }
    }
    const sources = this.connectionSources(connection.id).filter(source => source.selected && (!range.tickTickOnly || this.syncMinutes(source.calendarId) > 0));
    const remaining = sources.filter(source => !preferencesOnly || !this.preferenceHealth(source, connection, range));
    if (!remaining.length) return;
    const jobs = remaining.map(source => ({ source, start: range.start, end: range.end, zone: range.zone }));
    if (!client) {
      try { client = this.clientForReads(connection, jobs, forceRefresh); }
      catch (error) {
        failure = error;
        range.discoveryErrors.set(connection.id, failedCheck(connection.id, error));
      }
    }
    if (connection.provider === 'ticktick' && (client?.itemsForSources || !client && (!failure || failure.status === 429))) {
      const checks = await this.refreshTickTickRanges(connection, client, jobs, { ...range, forceRefresh, failure });
      for (const [id, health] of checks) range.checks.set(id, { health, at: Date.now() });
      return;
    }
    const iterator = remaining.values();
    const worker = async () => {
      for (const source of iterator) {
        const health = await this.refreshSource(source, connection, client, range, failure);
        range.checks.set(source.id, { health, at: Date.now() });
      }
    };
    const limit = connection.provider === 'ticktick' ? 4 : 1;
    await Promise.all(Array.from({ length: Math.min(limit, remaining.length) }, worker));
  }

  reconcileTickTickLocations(connectionId, locations) {
    if (!locations.size) return;
    for (const [sourceId, cache] of Object.entries(this.data.cache)) {
      if (JSON.parse(sourceId)[0] !== connectionId) continue;
      for (const item of cache.items) {
        const owner = locations.get(item.id);
        if (owner && owner !== sourceId) item.movedToSourceId = owner;
      }
    }
  }

  storeFetchedItems(source, connection, fetched, { start, end, zone, writtenItems, checkedAt = new Date().toISOString(), locations }) {
    const cache = this.cache(source.id);
    const preserved = writtenItems?.get(source.id);
    const items = preserved ? fetched.filter(item => !preserved.has(item.id)) : fetched;
    if (source.provider === 'ticktick' && !connection.tickTickInboxId && isTickTickInbox(source.remote)) {
      const item = originalInboxItem(items);
      if (item) connection.tickTickInboxId = item._ticktick.projectId;
    }
    const byId = new Map(items.map(item => [item.id, item]));
    const visibilityIds = new Set();
    for (const item of items) if (item.visibilityId) visibilityIds.add(item.visibilityId);
    if (visibilityIds.size) {
      for (const entry of this.data.hidden) {
        if (entry.sourceId !== source.id || entry.visibilityId) continue;
        const known = byId.get(entry.id);
        if (known?.visibilityId) entry.visibilityId = known.visibilityId;
      }
    }
    cache.items = cache.items.filter(item => preserved?.has(item.id) ||
      !byId.has(item.id) && !visibilityIds.has(item.visibilityId) && !overlaps(item, start, end)).concat(items);
    if (source.provider === 'ticktick') {
      if (locations) for (const item of items) locations.set(item.id, source.id);
      else this.reconcileTickTickLocations(source.connectionId, new Map(items.map(item => [item.id, source.id])));
    }
    const check = { start, end, zone, checkedAt };
    const limit = source.provider === 'ticktick' ? 96 : 30;
    cache.checks = [check, ...cache.checks.filter(old => old.start !== start || old.end !== end || old.zone !== zone)].slice(0, limit);
    if (cache.tickTickFailures) {
      cache.tickTickFailures = outsideWindow(cache.tickTickFailures, check);
      if (!cache.tickTickFailures.length) delete cache.tickTickFailures;
    }
    const visible = this.lastRange;
    if (source.provider === 'ticktick' && visible?.zone === zone && visible.start < end && visible.end > start &&
        visible.checks.has(source.id) && !failedWindow(cache, visible.start, visible.end, zone)) {
      const covered = rangeCheckedAt(cache.checks, visible.start, visible.end, zone);
      if (covered) visible.checks.set(source.id, { health: currentHealth(source, connection, covered), at: Date.now() });
    }
    return check;
  }

  async refreshSource(source, connection, client, range, failure) {
    const { start, end, zone } = range;
    if (connection.provider === 'ticktick' && client?.itemsForSources) {
      const result = await this.refreshTickTickRanges(connection, client, [{ source, start, end, zone }],
        { forceRefresh: true, preload: false, writtenItems: range.writtenItems, failure });
      return result.get(source.id);
    }
    try {
      const blocked = tickTickCooldown(connection.tickTickRateLimit);
      if (blocked || failure?.status === 429) throw blocked ?? failure;
      if (!client) throw failure ?? new Error('Reconnect this account to refresh.');
      const fetched = await client.items(source.remote, start, end);
      return currentHealth(source, connection, this.storeFetchedItems(source, connection, fetched, range).checkedAt);
    } catch (error) {
      const reason = this.requestError(connection, error);
      if (connection.provider === 'ticktick') this.rememberTickTickFailure(source, connection, range, reason);
      const checkedAt = rangeCheckedAt(this.cache(source.id).checks, start, end, zone);
      return failedCheck(connection.id, reason, source.id, checkedAt);
    }
  }

  async refreshTickTickRanges(connection, client, jobs, {
    forceRefresh = false, preload = true, tickTickReads = tickTickReadCycle(), writtenItems, failure,
  } = {}) {
    if (!jobs.length) return new Map();
    if (failure?.status === 429) tickTickReads.limited.set(connection.id, failure);
    const now = Date.now();
    const { zone } = jobs[0];
    const checksFor = ({ source }) => {
      if (forceRefresh) return tickTickReads.checked.get(source.id) ?? [];
      const cache = this.cache(source.id);
      const minutes = this.syncMinutes(source.calendarId);
      let checked = recentTaskChecks(cache.checks, zone, minutes, now);
      const failures = (cache.tickTickFailures ?? []).filter(check => check.zone === zone);
      if (!minutes) return checked.concat(failures);
      for (const failed of failures) checked = outsideWindow(checked, failed);
      return checked.concat(failures.filter(failed => retryTime(failed, minutes) > now));
    };
    const previousFailure = job => tickTickReads.failures.get(job.source.id)?.find(check =>
      check.start < job.end && check.end > job.start)?.error;
    const pending = jobs.filter(job => !previousFailure(job));
    const writtenIds = new Set();
    for (const [sourceId, ids] of writtenItems ?? []) {
      if (JSON.parse(sourceId)[0] === connection.id) for (const id of ids) writtenIds.add(id);
    }
    for (const { sources, start, end } of planTickTickReads(pending, checksFor, preload)) {
      try {
        const blocked = tickTickReads.limited.get(connection.id) ?? tickTickCooldown(connection.tickTickRateLimit);
        if (blocked) throw blocked;
        if (!client && failure) throw failure;
        client ??= this.client(connection);
        if (!client.itemsForSources) {
          const checks = new Map();
          for (const job of jobs) checks.set(job.source.id, await this.refreshSource(job.source, connection, client, { ...job, writtenItems }));
          return checks;
        }
        const items = await client.itemsForSources([...sources].map(source => source.remote), start, end);
        if (!(items instanceof Map) || [...sources].some(source => !Array.isArray(items.get(source.remote.id)))) {
          throw new Error('TickTick returned an incomplete calendar response.');
        }
        const checkedAt = new Date().toISOString();
        const locations = new Map();
        for (const source of sources) {
          const rows = items.get(source.remote.id);
          const fetched = writtenIds.size ? rows.filter(item => !writtenIds.has(item.id)) : rows;
          const check = this.storeFetchedItems(source, connection, fetched, { start, end, zone, writtenItems, checkedAt, locations });
          const checked = tickTickReads.checked.get(source.id) ?? [];
          checked.push(check);
          tickTickReads.checked.set(source.id, checked);
        }
        this.reconcileTickTickLocations(connection.id, locations);
      } catch (error) {
        const reason = this.requestError(connection, error);
        if (reason.status === 429) tickTickReads.limited.set(connection.id, reason);
        for (const source of sources) {
          const failures = tickTickReads.failures.get(source.id) ?? [];
          failures.push({ start, end, error: reason });
          tickTickReads.failures.set(source.id, failures);
          this.rememberTickTickFailure(source, connection, { start, end, zone }, reason);
        }
      }
    }
    const blocked = tickTickReads.limited.get(connection.id) ?? tickTickCooldown(connection.tickTickRateLimit);
    const result = new Map();
    for (const job of jobs) {
      const { source, start, end } = job;
      const cache = this.cache(source.id);
      const failed = failedWindow(cache, start, end, zone);
      const error = blocked ?? previousFailure(job) ?? failed?.error;
      const checkedAt = rangeCheckedAt(cache.checks, start, end, zone);
      result.set(source.id, error ? failedCheck(connection.id, error, source.id, checkedAt) : currentHealth(source, connection, checkedAt));
    }
    return result;
  }

  async state({ start, end, cachedOnly = false, preferencesOnly = false, refreshNotifications = false, macOnly = false,
    tickTickOnly = false, forceRefresh = !preferencesOnly && !tickTickOnly }, writtenItems) {
    validateRange(start, end);
    if (cachedOnly === true) return this.cachedState(start, end);
    const legacy = this.data.connections.find(legacyMacGoogle);
    if (legacy && !preferencesOnly && !tickTickOnly) {
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
    const tickTickReads = tickTickReadCycle();
    const connections = tickTickOnly ? this.data.connections.filter(connection => connection.provider === 'ticktick') :
      macOnly ? this.data.connections.filter(usesMacCalendars) : this.data.connections;
    await Promise.all(connections.map(connection => this.refreshConnection(connection, { ...range, writtenItems, tickTickReads, tickTickOnly },
      preferencesOnly === true, forceRefresh === true)));
    await this.notifications.refresh({ read: refreshNotifications ? 'all' : preferencesOnly ? 'none' : 'changed',
      checkedRange: preferencesOnly ? undefined : { start, end, health: this.cachedHealth(start, end, zone) }, writtenItems, macOnly,
      tickTickReads, tickTickOnly, forceRefresh: refreshNotifications && forceRefresh });
    this.profile.save();
    range.visible = new Set(this.data.sources.filter(source => source.selected).map(source => source.id));
    return this.cachedState(start, end);
  }

  cachedHealth(start, end, zone) {
    const range = this.lastRange;
    const matches = range?.start === start && range.end === end && range.zone === zone;
    return this.data.connections.flatMap(connection => {
      const blocked = tickTickCooldown(connection.tickTickRateLimit);
      if (blocked) {
        const sources = this.connectionSources(connection.id).filter(source => source.selected);
        return [failedCheck(connection.id, blocked), ...sources.map(source => failedCheck(connection.id, blocked, source.id,
          rangeCheckedAt(this.data.cache[source.id]?.checks ?? [], start, end, zone)))];
      }
      const error = matches && range.discoveryErrors.get(connection.id);
      const checks = this.connectionSources(connection.id).filter(source => source.selected)
        .map(source => {
          const cache = this.data.cache[source.id];
          const failure = failedWindow(cache, start, end, zone);
          if (failure) return failedCheck(connection.id, failure.error, source.id, rangeCheckedAt(cache.checks, start, end, zone));
          return matches && range.checks.get(source.id)?.health;
        }).filter(Boolean);
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
      .filter(item => !item.completed && !item.movedToSourceId && overlaps(item, start, end) && !this.data.hidden.some(h => sameHiddenItem(h, source.id, item)))
      .map(item => publicItem(item, source)));
    const options = this.providers.connectionOptions ?? {};
    const googleBrowser = Boolean(options.googleBrowser || this.data.connections.some(c => c.provider === 'google' && c.route !== 'mac'));
    const integrations = options.integrations?.map(entry => entry.id === 'google' && googleBrowser && !entry.routes.includes('browser')
      ? { ...entry, routes: ['browser', ...entry.routes] } : entry);
    return {
      connectionOptions: { ...options, googleBrowser, integrations, tickTickSyncIntervals: tickTickSyncMinutes },
      connections: this.data.connections.map(connection => {
        const { id, provider, name, route, accountId, ticktick } = connection;
        return { id, provider, name, route, ...(accountId && { accountId }), ...(legacyMacGoogle(connection) && { legacyMac: true }),
          ...(ticktick && { ticktick: publicTickTickSettings(ticktick), tickTickRequestStats: publicRequestStats(connection.tickTickRequestStats) }) };
      }),
      ticktickCalendars: this.data.connections.flatMap(connection => this.tickTickCalendars.get(connection.id) ?? [])
        .map(calendar => this.withCalendarColor({ ...calendar, syncMinutes: this.syncMinutes(calendar.id) })),
      notificationPreferences: this.notifications.preferences(), notificationError: this.notifications.error,
      notificationFailures: [...this.notifications.failures.values()],
      snapshotId: ++this.snapshotId, sources, items, rangeCovered, hidden: this.data.hidden,
      nextTickTickRefreshAt: this.nextTickTickRefreshAt(start, end, zone),
      health: health ?? this.cachedHealth(start, end, zone),
      uncertain: this.data.journal.filter(entry => !this.activeWriteIds.has(entry.id))
    };
  }

  hide(reference) {
    const { sourceId } = reference;
    this.source(sourceId);
    const item = this.cache(sourceId).items.find(entry => sameHiddenItem(reference, sourceId, entry));
    if (!item) throw new Error('Refresh the calendar and select the item again.');
    if (this.data.hidden.some(entry => sameHiddenItem(entry, sourceId, item))) return;
    this.saveHidden([...this.data.hidden, { sourceId, id: item.id, title: item.title, ...(item.visibilityId && { visibilityId: item.visibilityId }) }]);
  }

  restore(reference) {
    const next = this.data.hidden.filter(entry => !sameHiddenItem(entry, reference.sourceId, reference));
    if (next.length !== this.data.hidden.length) this.saveHidden(next);
  }

  saveHidden(next) {
    const previous = this.data.hidden;
    this.data.hidden = next;
    try { this.profile.save(); }
    catch (error) { this.data.hidden = previous; throw error; }
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
    if (source.provider === 'ticktick' && (item || original)) {
      this.reconcileTickTickLocations(source.connectionId, new Map([[(item ?? original).id, source.id]]));
    }
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
    const blocked = tickTickCooldown(connection.tickTickRateLimit);
    if (blocked) throw blocked;
    const client = this.client(connection);
    const cache = this.cache(source.id);
    const original = action === 'create' ? null : cache.items.find(item => item.id === input.id);
    if (action !== 'create') {
      if (!original || original.version !== input.version || original.completed || original.movedToSourceId) {
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
      error = this.requestError(connection, error);
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
