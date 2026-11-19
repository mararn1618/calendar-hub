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

export const providers = { ticktick: 'TickTick', google: 'Google', mac: 'Mac calendars' };

export function providerMark(provider) {
  const mark = element('span', 'provider-mark ' + provider, { ticktick: '✓', google: 'G', mac: '▦' }[provider] || '•');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

export function writable(source) {
  return Boolean(source?.writable && !source.readOnly && ['ticktick', 'google'].includes(source.provider));
}

export function editable(item, source) {
  return Boolean(item?.canEdit && writable(source) && !(item.recurring && source.provider === 'ticktick'));
}

export function completable(item, source) {
  return Boolean(item?.canComplete && writable(source) && source.provider === 'ticktick' && !item.completed && !item.recurring);
}

export function deletable(item, source) {
  return Boolean(item?.canDelete && writable(source) && source.provider === 'google');
}

export function sourceColor(source) {
  const defaults = { ticktick: '#607abc', google: '#51897c', mac: '#a278ac' };
  return source?.color && CSS.supports('color', source.color) ? source.color : defaults[source?.provider] || '#567e91';
}

export function sourceCheckbox(source, change, status) {
  const row = element('label', 'source-toggle');
  row.style.setProperty('--source-color', sourceColor(source));
  const check = element('input');
  check.type = 'checkbox';
  check.checked = source.selected;
  check.dataset.sourceId = source.id;
  check.setAttribute('aria-label', source.name);
  check.addEventListener('change', () => {
    check.disabled = true;
    change(check.checked);
  });
  const label = element('span', 'source-name', source.name);
  label.title = source.name;
  row.append(check, label);
  if (source.readOnly || !source.writable) {
    const lock = icon('lock');
    lock.title = 'Read-only';
    row.append(lock);
  }
  if (status && status.state !== 'current') {
    const warning = element('span', 'health-warning', '!');
    warning.setAttribute('aria-label', status.state);
    warning.title = status.message || 'Source unavailable';
    row.append(warning);
  }
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
