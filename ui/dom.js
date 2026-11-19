export const $ = selector => document.querySelector(selector);

export function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name) {
  const node = element('span', 'icon i-' + name);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function button(label, action, className = '') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function iconButton(label, symbol, action) {
  const node = button('', action, 'icon-button');
  node.setAttribute('aria-label', label);
  node.title = label;
  node.append(icon(symbol));
  return node;
}

export function nativeAccountLabels(accounts) {
  const byName = new Map();
  for (const [id, name] of accounts) {
    const ids = byName.get(name) || [];
    ids.push(id);
    byName.set(name, ids);
  }
  const labels = new Map();
  for (const [name, ids] of byName) {
    ids.sort();
    ids.forEach((id, index) => labels.set(id, ids.length === 1 ? name : name + ' (' + (index + 1) + ')'));
  }
  return labels;
}

export function labelNativeSources(sources) {
  const accounts = new Map();
  const duplicates = new Map();
  const sourceKey = source => JSON.stringify([source.connectionId, source.name]);
  for (const source of sources) {
    if (!source.nativeAccountId) continue;
    accounts.set(source.nativeAccountId, source.nativeAccountName || 'Apple Calendar account');
    const key = sourceKey(source);
    duplicates.set(key, (duplicates.get(key) || 0) + 1);
  }
  const labels = nativeAccountLabels(accounts);
  return sources.map(source => {
    if (!source.nativeAccountId || duplicates.get(sourceKey(source)) < 2) return source;
    return { ...source, name: source.name + ' · ' + labels.get(source.nativeAccountId) };
  });
}

export function accountLabel(connection, connections) {
  const name = connection.name || connection.providerName || connection.provider;
  const sameName = connections.filter(row => (row.name || row.providerName || row.provider) === name);
  const matches = sameName.filter(row => row.provider === connection.provider);
  const label = matches.length > 1 ? name + ' (' + (matches.findIndex(row => row.id === connection.id) + 1) + ')' : name;
  return sameName.length > matches.length ? label + ' (' + (connection.providerName || connection.provider) + ')' : label;
}

export function sourceContext(source, connections, calendarName) {
  if (!source) return 'Calendar';
  const connection = connections.find(row => row.id === source.connectionId);
  const account = connection && accountLabel(connection, connections);
  return [...new Set([account, calendarName, source.folder?.name, source.name].filter(Boolean))].join(' · ');
}

export function providerMark(provider) {
  const mark = element('span', 'provider-mark ' + provider, { ticktick: '✓', google: 'G', exchange: 'E', mac: '▦' }[provider] || '•');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

export function writable(source) {
  return Boolean(source?.writable && !source.readOnly);
}

export function editable(item, source) {
  return Boolean(item?.canEdit && writable(source) && !(item.recurring && source.itemKind === 'task'));
}

export function completable(item, source) {
  return Boolean(item?.canComplete && writable(source) && source.itemKind === 'task' && !item.completed && !item.recurring);
}

export function deletable(item, source) {
  return Boolean(item?.canDelete && writable(source) && source.itemKind === 'event');
}

export function sourceColor(source) {
  const defaults = { ticktick: '#607abc', google: '#647da3', mac: '#a278ac' };
  return source?.color && CSS.supports('color', source.color) ? source.color : defaults[source?.provider] || '#567e91';
}

function coloredCheckbox(name, color, checked, change) {
  const row = element('label', 'source-toggle');
  row.style.setProperty('--source-color', color);
  const check = element('input');
  check.type = 'checkbox';
  check.checked = checked;
  check.setAttribute('aria-label', name);
  check.addEventListener('change', () => {
    check.disabled = true;
    change(check.checked);
  });
  const label = element('span', 'source-name', name);
  label.title = name;
  row.append(check, label);
  return { row, check };
}

function showHealth(row, status) {
  if (status && status.state !== 'current') {
    const warning = element('span', 'health-warning', '!');
    warning.setAttribute('aria-label', status.state);
    warning.title = status.message || 'Source unavailable';
    row.append(warning);
  }
}

export function sourceCheckbox(source, change, status) {
  const { row, check } = coloredCheckbox(source.name, sourceColor(source), source.selected, change);
  check.dataset.sourceId = source.id;
  if (source.readOnly || !source.writable) {
    const lock = icon('lock');
    lock.title = 'Read-only';
    row.append(lock);
  }
  showHealth(row, status);
  return row;
}

export function tickTickCalendarCheckbox(calendar, change, health) {
  const { row, check } = coloredCheckbox(calendar.name, sourceColor({ provider: 'ticktick', color: calendar.color }), calendar.visible, change);
  check.dataset.calendarId = calendar.id;
  check.dataset.connectionId = calendar.connectionId;
  const count = calendar.sourceIds.length;
  check.setAttribute('aria-description', count + (count === 1 ? ' TickTick list' : ' TickTick lists'));
  showHealth(row, health.find(entry => entry.connectionId === calendar.connectionId && entry.state !== 'current' &&
    (!entry.sourceId || calendar.sourceIds.includes(entry.sourceId))));
  return row;
}

export function healthFor(source, health) {
  return health.find(entry => entry.sourceId === source.id)
    || health.find(entry => entry.connectionId === source.connectionId && !entry.sourceId);
}

export function errorText(error) {
  const message = error?.message || String(error);
  return message.replace(/^Error invoking remote method [^:]+:\s*(?:Error:\s*)?/, '');
}
