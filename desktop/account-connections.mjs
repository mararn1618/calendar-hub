import { randomUUID } from 'node:crypto';

export function legacyMacGoogle(connection) {
  return connection.provider === 'google' && connection.route === 'mac' && !connection.accountId;
}

export function availableAccountName(base, connections, provider, exceptId) {
  const used = new Set(connections.filter(row => row.provider === provider && row.id !== exceptId)
    .map(row => row.name?.toLocaleLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLocaleLowerCase()); n++) name = base + ' (' + n + ')';
  return name;
}

function savedSourceIds(data, connectionId) {
  const ids = [
    ...data.sources.filter(row => row.connectionId === connectionId).map(row => row.id),
    ...data.hidden.map(row => row.sourceId), ...data.journal.map(row => row.sourceId),
    ...Object.keys(data.cache), ...Object.keys(data.notificationPreferences ?? {}), ...Object.keys(data.calendarColorOverrides ?? {}),
    ...Object.keys(data.unavailableSourceSettings ?? {}),
  ];
  const remoteIds = new Set();
  for (const id of ids) {
    const [owner, remoteId] = JSON.parse(id);
    if (owner === connectionId) remoteIds.add(remoteId);
  }
  return remoteIds;
}

function moveSourceState(data, oldId, id, connectionId) {
  const previous = data.sources.find(source => source.id === oldId);
  const saved = data.sources.find(source => source.id === id);
  if (previous && saved) {
    saved.readOnly ||= previous.readOnly;
    data.sources = data.sources.filter(row => row !== previous);
  } else if (previous) Object.assign(previous, { id, connectionId });
  for (const entry of data.hidden) if (entry.sourceId === oldId) entry.sourceId = id;
  for (const entry of data.journal) if (entry.sourceId === oldId) Object.assign(entry, { sourceId: id, connectionId });
  const oldCache = data.cache[oldId], cache = data.cache[id];
  if (oldCache && cache) {
    const seen = new Set(cache.items.map(item => item.id));
    cache.items.push(...oldCache.items.filter(item => !seen.has(item.id)));
    cache.checks = [...cache.checks, ...oldCache.checks].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).slice(0, 30);
  }
  for (const table of [data.cache, data.notificationPreferences, data.calendarColorOverrides, data.unavailableSourceSettings]) {
    if (table && Object.hasOwn(table, oldId)) {
      table[id] ??= table[oldId];
      delete table[oldId];
    }
  }
}

export function splitMacGoogleConnection(profile, providers, connection, inventory) {
  const { data } = profile;
  const calendars = new Map(inventory.map(row => [row.id, row]));
  const previous = profile.open(connection).googleCalendarIds;
  const selected = new Set(previous);
  const remoteIds = new Set([...selected, ...savedSourceIds(data, connection.id)]);
  if (!selected.size) return;
  const groups = new Map();
  for (const id of remoteIds) {
    const row = calendars.get(id);
    if (!row?.accountId) return;
    if (!groups.has(row.accountId)) groups.set(row.accountId, []);
    groups.get(row.accountId).push(row);
  }
  const others = data.connections.filter(row => row.id !== connection.id);
  const replacements = [], additions = [], moves = [];
  let originalIdAvailable = true;
  for (const [accountId, rows] of groups) {
    const existing = others.find(row => row.provider === 'google' && row.route === 'mac' && row.accountId === accountId);
    const ids = new Set(existing ? profile.open(existing).googleCalendarIds : []);
    for (const row of rows) if (selected.has(row.id)) ids.add(row.id);
    const secret = { route: 'mac', accountId, googleCalendarIds: [...ids] };
    const accountKey = providers.identity('google', secret, rows);
    const id = existing?.id ?? (originalIdAvailable ? connection.id : randomUUID());
    const base = id === connection.id && connection.name !== 'Google via Apple Calendar' ? connection.name : rows[0].accountName;
    const name = existing?.name || availableAccountName(base || 'Google Calendar', [...others, ...additions], 'google');
    const account = { ...connection, ...existing, id, name, accountId, accountKey, secret: profile.seal(secret) };
    if (existing) replacements.push([existing, account]);
    else {
      additions.push(account);
      originalIdAvailable = false;
    }
    if (id !== connection.id) for (const row of rows) moves.push([JSON.stringify([connection.id, row.id]), JSON.stringify([id, row.id]), id]);
  }

  for (const [existing, account] of replacements) data.connections[data.connections.indexOf(existing)] = account;
  data.connections.splice(data.connections.indexOf(connection), 1, ...additions);
  for (const [oldId, id, connectionId] of moves) moveSourceState(data, oldId, id, connectionId);
  if (moves.length) {
    data.hidden = [...new Map(data.hidden.map(entry => [JSON.stringify([entry.sourceId, entry.id]), entry])).values()];
  }
  return [connection.id, ...replacements.map(([existing]) => existing.id)];
}
