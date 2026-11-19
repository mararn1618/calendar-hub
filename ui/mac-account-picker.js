import { button, element, nativeAccountLabels } from './dom.js';

export function showRetainedCalendars(body, rows, legacy) {
  if (!rows.length) return;
  const calendars = element('fieldset', 'mac-calendar-choices');
  calendars.append(element('legend', 'field-label', 'Selections to keep'));
  for (const row of rows) {
    const choice = element('input');
    choice.type = 'checkbox';
    choice.checked = true;
    choice.disabled = true;
    const label = element('label', 'check-field');
    const name = [legacy && row.accountName, row.name || row.id].filter(Boolean).join(' · ');
    label.append(choice, document.createTextNode(name + ' (temporarily unavailable)'));
    calendars.append(label);
  }
  body.append(calendars);
}

export function showMacAccountPicker({ body, footer, provider, connection, rows, retained, nameField, connect }) {
  const isGoogle = provider === 'google';
  const legacy = isGoogle && connection?.legacyMac;
  const accounts = new Map();
  for (const row of rows) {
    let account = accounts.get(row.accountId);
    if (!account) {
      account = { id: row.accountId, name: row.accountName || 'Apple Calendar account', rows: [] };
      accounts.set(account.id, account);
    }
    account.rows.push(row);
  }
  const sorted = [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const labels = nativeAccountLabels(new Map(sorted.map(account => [account.id, account.name])));
  for (const account of sorted) {
    account.label = labels.get(account.id);
    account.connected = account.rows.some(row => row.connected);
  }

  const picker = element('select');
  picker.setAttribute('aria-label', 'Apple Calendar account');
  const placeholder = element('option', '', 'Choose an account');
  placeholder.value = '';
  picker.append(placeholder);
  for (const account of sorted) {
    const option = element('option', '', account.label + (account.connected && !connection ? ' (connected)' : ''));
    option.value = account.id;
    option.disabled = !connection && account.connected;
    picker.append(option);
  }
  if (connection) picker.value = connection.accountId || rows.find(row => row.chosen)?.accountId || '';
  else {
    const available = sorted.filter(account => !account.connected);
    if (!isGoogle && available.length === 1) picker.value = available[0].id;
  }
  if (!legacy) {
    const field = element('label', 'field');
    field.append(element('span', 'field-label', 'Apple Calendar account'), picker);
    picker.disabled = Boolean(connection);
    body.append(field);
  }

  const calendars = element('fieldset', 'mac-calendar-choices');
  const selected = new Set(rows.filter(row => row.chosen && (legacy || row.accountId === picker.value)).map(row => row.id));
  const submit = button(connection ? 'Save calendars' : isGoogle ? 'Use selected calendars' : 'Connect Exchange account', () => {
    const payload = { provider, route: 'mac' };
    if (!legacy) payload.accountId = picker.value;
    if (connection) payload.connectionId = connection.id;
    if (nameField?.value.trim()) payload.name = nameField.value.trim();
    if (isGoogle) payload.googleCalendarIds = [...selected, ...retained.map(row => row.id)];
    connect(payload);
  }, 'primary');
  const updateSubmit = () => { submit.disabled = (!legacy && !picker.value) || (isGoogle && !selected.size && !retained.length); };
  function renderCalendars() {
    calendars.replaceChildren();
    const visible = legacy ? sorted : [accounts.get(picker.value)].filter(Boolean);
    for (const account of visible) {
      if (legacy && account.connected && !account.rows.some(row => row.chosen)) continue;
      for (const row of account.rows) {
        const label = element('label', 'check-field');
        const check = element('input');
        check.type = 'checkbox';
        check.checked = selected.has(row.id);
        check.addEventListener('change', () => {
          if (check.checked) selected.add(row.id);
          else selected.delete(row.id);
          updateSubmit();
        });
        const name = (legacy ? account.label + ' · ' : '') + row.name + (row.writable ? '' : ' (read-only)');
        label.append(check, document.createTextNode(name));
        calendars.append(label);
      }
    }
    calendars.hidden = !calendars.childElementCount;
    if (!calendars.hidden) calendars.prepend(element('legend', 'field-label', 'Calendars to connect'));
  }
  function showAccount() {
    if (isGoogle) renderCalendars();
    if (nameField) nameField.placeholder = accounts.get(picker.value)?.label || 'e.g. Work';
    updateSubmit();
  }
  picker.addEventListener('change', () => {
    selected.clear();
    showAccount();
  });
  if (isGoogle) body.append(calendars);
  showAccount();
  footer.append(submit);
}
