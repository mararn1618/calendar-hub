const modes = ['account', 'folders', 'custom'];
const calendarId = (connectionId, kind, id = null) => JSON.stringify([connectionId, kind, id]);
const belongsTo = (sourceId, connectionId) => JSON.parse(sourceId)[0] === connectionId;

export const isTickTickInbox = source => source?.inbox === true || /^inbox(?:\d+)?$/.test(source?.id);

export function tickTickSettings(connectionId, sources, unavailable, fresh = false) {
  const selected = sources.filter(source => source.selected).map(source => source.id);
  for (const [id, settings] of Object.entries(unavailable)) {
    if (settings.selected && belongsTo(id, connectionId)) selected.push(id);
  }
  return {
    mode: 'account', includedSourceIds: selected.length ? selected : null, groups: [],
    hiddenCalendarIds: !fresh && !selected.length ? [calendarId(connectionId, 'account')] : [],
  };
}

export function publicTickTickSettings({ mode, includedSourceIds, groups }) {
  return { mode, includesAll: includedSourceIds === null, includedSourceIds, groups };
}

export function configureTickTickSettings(previous, input, availableIds, unavailable) {
  const { connectionId, mode = previous.mode } = input;
  if (!modes.includes(mode)) throw new Error('Choose a TickTick calendar grouping.');
  const knownIds = new Set(availableIds);
  for (const id of Object.keys(unavailable)) if (belongsTo(id, connectionId)) knownIds.add(id);

  function listIds(ids) {
    if (!Array.isArray(ids) || ids.some(id => !knownIds.has(id))) {
      throw new Error('Choose task lists from this TickTick account.');
    }
    return [...new Set(ids)];
  }

  let { includedSourceIds, groups, hiddenCalendarIds, calendarColors } = previous;
  if (input.includedSourceIds !== undefined) {
    includedSourceIds = input.includedSourceIds === null ? null : listIds(input.includedSourceIds);
  }
  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups)) throw new Error('Choose the custom TickTick calendars.');
    const groupIds = new Set();
    const assigned = new Set();
    groups = input.groups.map(group => {
      if (typeof group?.id !== 'string' || !group.id.trim() || groupIds.has(group.id)) {
        throw new Error('Each custom calendar needs a separate ID.');
      }
      if (typeof group.name !== 'string' || !group.name.trim()) throw new Error('Enter a calendar name.');
      groupIds.add(group.id);
      const sourceIds = listIds(group.sourceIds);
      for (const id of sourceIds) {
        if (assigned.has(id)) throw new Error('A TickTick list can belong to only one custom calendar.');
        assigned.add(id);
      }
      return { id: group.id, name: group.name.trim(), sourceIds };
    });
    const removed = new Set(previous.groups.filter(group => !groupIds.has(group.id))
      .map(group => calendarId(connectionId, 'custom', group.id)));
    hiddenCalendarIds = hiddenCalendarIds.filter(id => !removed.has(id));
    if (removed.size && calendarColors?.custom) {
      const custom = Object.fromEntries(Object.entries(calendarColors.custom).filter(([id]) => !removed.has(id)));
      calendarColors = { ...calendarColors, custom };
    }
  }
  return { mode, includedSourceIds, groups, hiddenCalendarIds, ...(calendarColors && { calendarColors }) };
}

function orderValue(value) {
  if (Number.isSafeInteger(value) || typeof value === 'string' && /^-?\d+$/.test(value)) return String(value);
  return null;
}

export function listMetadata(remote) {
  const inbox = isTickTickInbox(remote);
  const groupId = inbox ? null : remote.groupId ?? null;
  const folder = remote.folder;
  return {
    inbox, groupId, archived: Boolean(remote.archived), sortOrder: orderValue(remote.sortOrder),
    ...(groupId && folder?.id === groupId && { folder: {
      id: groupId, name: folder.name, sortOrder: orderValue(folder.sortOrder),
    } }),
  };
}

export function retainTickTickFolders(connectionId, previous, unavailable, discovered) {
  const folders = new Map();
  for (const [id, settings] of Object.entries(unavailable)) {
    if (settings.folder && belongsTo(id, connectionId)) folders.set(settings.folder.id, settings.folder);
  }
  for (const source of previous) {
    if (source.remote.folder) folders.set(source.remote.folder.id, source.remote.folder);
  }
  for (const remote of discovered) {
    if (remote.folder?.id === remote.groupId && remote.folder?.name) folders.set(remote.groupId, remote.folder);
  }
  return discovered.map(remote => {
    const folder = folders.get(remote.groupId);
    return folder ? { ...remote, folder } : remote;
  });
}

function nativeOrder(rows, sortOrder) {
  const ranked = rows.flatMap(row => {
    const value = orderValue(sortOrder(row));
    return value === null ? [] : [{ row, order: BigInt(value) }];
  });
  ranked.sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
  let index = 0;
  return rows.map(row => orderValue(sortOrder(row)) === null ? row : ranked[index++].row);
}

export function orderedTickTickSources(sources) {
  const inbox = [], roots = [], folders = new Map();
  for (const source of sources) {
    const { groupId, folder, sortOrder } = source.remote;
    if (isTickTickInbox(source.remote)) {
      inbox.push(source);
    } else if (!groupId) {
      roots.push({ sortOrder, sources: [source] });
    } else {
      if (!folders.has(groupId)) {
        const entry = { sortOrder: folder?.sortOrder, sources: [] };
        folders.set(groupId, entry);
        roots.push(entry);
      }
      folders.get(groupId).sources.push(source);
    }
  }
  return inbox.concat(nativeOrder(roots, row => row.sortOrder)
    .flatMap(row => nativeOrder(row.sources, source => source.remote.sortOrder)));
}

const groupColors = ['#4967a4', '#356e63', '#874f84', '#995138', '#647430', '#7956a1', '#896323', '#386e86'];

function calendarColor(settings, id, kind, groupId) {
  if (kind === 'account' || kind === 'remainder') return '#607abc';
  settings.calendarColors ??= {};
  const assigned = settings.calendarColors[settings.mode] ??= {};
  if (assigned[id]) return assigned[id];
  let hash = 0;
  for (const char of kind + '/' + (groupId ?? '')) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  const start = hash % groupColors.length;
  const used = new Set(Object.values(assigned));
  const colors = groupColors.slice(start).concat(groupColors.slice(0, start));
  assigned[id] = colors.find(color => !used.has(color)) ?? colors[0];
  return assigned[id];
}

export function applyTickTickCalendars(connection, sources) {
  const settings = connection.ticktick;
  const included = settings.includedSourceIds === null ? null : new Set(settings.includedSourceIds);
  const hidden = new Set(settings.hiddenCalendarIds);
  const calendars = new Map();
  const customForList = new Map();

  function calendar(kind, name, groupId) {
    const id = calendarId(connection.id, kind, groupId);
    if (!calendars.has(id)) {
      calendars.set(id, { id, connectionId: connection.id, name, visible: !hidden.has(id),
        color: calendarColor(settings, id, kind, groupId), sourceIds: [] });
    }
    return calendars.get(id);
  }

  if (settings.mode === 'account') calendar('account', connection.name);
  if (settings.mode === 'custom') {
    for (const group of settings.groups) {
      const row = calendar('custom', group.name, group.id);
      for (const id of group.sourceIds) customForList.set(id, row);
    }
  }
  for (const source of sources) {
    source.included = included ? included.has(source.id) : !source.remote.archived;
    source.calendarId = null;
    source.selected = false;
    if (!source.included) continue;
    let row;
    if (settings.mode === 'folders') {
      const { groupId, folder } = listMetadata(source.remote);
      row = groupId ? calendar('folder', folder?.name || 'TickTick folder', groupId) : calendar('unfiled', 'Unfiled lists');
    } else if (settings.mode === 'custom') {
      row = customForList.get(source.id) ?? calendar('remainder', connection.name);
    } else {
      row = calendar('account', connection.name);
    }
    row.sourceIds.push(source.id);
    source.calendarId = row.id;
    source.selected = row.visible;
  }
  return [...calendars.values()];
}
