import { $, button, completable, deletable, editable, element, errorText, healthFor, icon, iconButton, providerMark, providers, sourceCheckbox, writable } from './dom.js';
import { MINUTE, SLOT, addDays, differenceInDays, formatDate, localDate, localTime, possibleInstants, zoneOffset } from './dates.js';

const dateFormat = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
const asISO = value => new Date(value).toISOString();
const itemKey = item => ({ sourceId: item.sourceId, id: item.id, version: item.version });

function field(label, input) {
  const row = element('label', 'field');
  input.setAttribute('aria-label', label);
  row.append(element('span', 'field-label', label), input);
  return row;
}

function input(type, name, value = '') {
  const control = element('input');
  control.type = type;
  control.name = name;
  control.id = name;
  control.value = value;
  return control;
}

function check(label, checked = false) {
  const row = element('label', 'check-field');
  const control = element('input');
  control.type = 'checkbox';
  control.checked = checked;
  row.append(control, document.createTextNode(label));
  return { row, control };
}

function spanDescription(data) {
  if (data.allDay) {
    const last = addDays(data.end, -1);
    const dates = data.start === last ? formatDate(data.start, dateFormat) : formatDate(data.start, dateFormat) + ' – ' + formatDate(last, dateFormat);
    return dates + ' · All day';
  }
  const startDate = localDate(data.start), endDate = localDate(data.end);
  const start = formatDate(startDate, dateFormat) + ' · ' + localTime(data.start);
  if (Date.parse(data.start) === Date.parse(data.end)) return start + ' ' + zoneOffset(data.start);
  const end = (startDate === endDate ? '' : formatDate(endDate, dateFormat) + ' · ') + localTime(data.end);
  if (zoneOffset(data.start) !== zoneOffset(data.end)) return start + ' ' + zoneOffset(data.start) + ' – ' + end + ' ' + zoneOffset(data.end);
  return start + ' – ' + end + ' ' + zoneOffset(data.end);
}

export function createPanels(actions) {
  const dialog = $('#dialog');
  const menu = $('#context-menu');
  let kind;
  let body;
  let message;
  let footer;
  let escapeAction;
  let opener;
  let menuOpener;
  let busy = false;
  const state = () => actions.state();
  const sourceOf = item => state().sources.find(source => source.id === item.sourceId);
  const latestItem = item => state().items.find(entry => entry.id === item.id && entry.sourceId === item.sourceId);

  function close() {
    if (dialog.open) dialog.close();
    kind = undefined;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function panel(type, title, options = {}) {
    closeMenu(false);
    kind = type;
    escapeAction = options.back || close;
    if (!dialog.open) opener = document.activeElement;
    dialog.className = options.wide ? 'wide-dialog' : '';
    const header = element('header', 'dialog-head');
    const heading = element('h2', '', title);
    heading.id = 'dialog-title';
    header.append(heading, iconButton('Close', 'close', close));
    body = element('div', 'dialog-body');
    message = element('div', 'form-message');
    message.setAttribute('role', 'alert');
    message.hidden = true;
    footer = element('footer', 'dialog-footer');
    dialog.replaceChildren(header, body, message, footer);
    if (!dialog.open) dialog.showModal();
  }

  function returnToPanel() {
    if (!dialog.open) return close;
    const saved = { kind, body, message, footer, escapeAction, nodes: [...dialog.childNodes], className: dialog.className };
    return () => {
      ({ kind, body, message, footer, escapeAction } = saved);
      dialog.className = saved.className;
      dialog.replaceChildren(...saved.nodes);
      const first = body.querySelector('input:not([disabled]), select:not([disabled]), button');
      first?.focus({ preventScroll: true });
    };
  }

  function warning(text, extra) {
    if (!dialog.open) return actions.report(text, extra);
    message.textContent = text;
    if (extra) message.append(button(extra.label, extra.action, 'text-button'));
    message.hidden = false;
  }

  async function write(method, payload, success, failed) {
    if (busy) return;
    busy = true;
    message && (message.hidden = true);
    const controls = dialog.open ? [...dialog.querySelectorAll('button:enabled, input:enabled, select:enabled')] : [];
    controls.forEach(node => { node.disabled = true; });
    dialog.setAttribute('aria-busy', 'true');
    try {
      await actions.mutate(method, payload);
      success();
    } catch (error) {
      const text = errorText(error);
      if (failed) failed(text);
      else warning(text, dialog.open ? undefined : { label: 'Refresh', action: actions.refresh });
    } finally {
      busy = false;
      dialog.removeAttribute('aria-busy');
      controls.forEach(node => { node.disabled = false; });
    }
  }
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!busy) escapeAction?.();
  });

  function settings() {
    panel('settings', 'Calendars', { wide: true });
    const { connections, sources, health } = state();
    if (connections.length) {
      body.append(element('p', 'help', 'Choose the calendars and task lists to show. Keep the TickTick copy calendar off when its original list is selected.'));
    }
    for (const connection of connections) {
      const group = element('section', 'connection-group');
      const heading = element('div', 'connection-heading');
      const name = element('div', 'connection-name');
      name.append(providerMark(connection.provider), element('strong', '', connection.name || providers[connection.provider]));
      heading.append(name, button('Disconnect', () => disconnect(connection), 'text-button subdued'));
      group.append(heading);
      const listed = sources.filter(source => source.connectionId === connection.id);
      if (!listed.length) group.append(element('p', 'help', 'No calendars are available from this connection yet.'));
      for (const source of listed) {
        const row = element('div', 'settings-source');
        row.dataset.sourceId = source.id;
        const status = healthFor(source, health);
        row.append(sourceCheckbox(source, selected => setSource(source, { selected }), status));
        if (source.provider === 'google' && source.writable) {
          const policy = check('Read-only', source.readOnly);
          policy.row.classList.add('readonly-control');
          policy.control.setAttribute('aria-label', 'Read-only ' + source.name);
          policy.control.addEventListener('change', () => setSource(source, { readOnly: policy.control.checked }));
          row.append(policy.row);
        }
        if (status && status.state !== 'current' && status.message) row.append(element('p', 'source-error', status.message));
        group.append(row);
      }
      if (connection.provider === 'google' && listed.some(source => source.writable)) {
        group.append(element('p', 'help policy-help', 'Mark a BMW copy read-only to keep its meetings protected.'));
      }
      body.append(group);
    }
    body.append(element('h3', 'settings-subhead', 'Add a connection'));
    const options = element('div', 'provider-options');
    for (const [provider, label] of Object.entries(providers)) {
      const connect = button('', () => connectionForm(provider), 'provider-button');
      const title = provider === 'mac' ? 'Connect Mac calendars' : 'Connect ' + label;
      connect.setAttribute('aria-label', title);
      connect.append(providerMark(provider), document.createTextNode(label), icon('plus'));
      options.append(connect);
    }
    body.append(options);
    footer.append(button('Hidden items', hiddenItems, 'text-button'), button('Done', close, 'primary'));
  }
  function setSource(source, patch) {
    write('setSource', { sourceId: source.id, ...patch }, settings, text => {
      settings();
      warning(text);
    });
  }
  function disconnect(connection) {
    panel('disconnect', 'Disconnect calendar?', { back: settings });
    body.append(element('p', '', 'Remove ' + (connection.name || providers[connection.provider]) + ' from Calendar Central? Its tasks and events stay with the provider.'));
    footer.append(button('Cancel', settings), button('Disconnect', () => write('disconnect', { connectionId: connection.id }, settings), 'destructive'));
  }
  function connectionForm(provider) {
    const name = providers[provider];
    panel('connect', provider === 'mac' ? 'Connect Mac calendars' : 'Connect ' + name, { back: settings });
    const form = element('form', 'editor-form');
    form.id = 'connect-form';
    const connectionName = input('text', 'connection-name');
    connectionName.placeholder = name;
    form.append(field('Connection name (optional)', connectionName));
    let token, clientId, secret;
    if (provider === 'ticktick') {
      token = input('password', 'access-token');
      token.autocomplete = 'off';
      token.required = true;
      form.append(field('Access token', token), element('p', 'help', 'Use a TickTick Open API access token with task read and write access.'));
    } else if (provider === 'google') {
      clientId = input('text', 'client-id');
      clientId.required = true;
      clientId.spellcheck = false;
      secret = input('password', 'client-secret');
      secret.autocomplete = 'off';
      const file = input('file', 'desktop-credentials');
      file.accept = '.json,application/json';
      file.addEventListener('change', async () => {
        const selected = file.files[0];
        if (!selected) return;
        try {
          if (selected.size > 128 * 1024) throw new Error('Choose a Google desktop OAuth credentials JSON file.');
          const data = JSON.parse(await selected.text());
          if (typeof data?.installed?.client_id !== 'string' || !data.installed.client_id.trim()) {
            throw new Error('Choose credentials for a Google OAuth client of type Desktop app.');
          }
          clientId.value = data.installed.client_id.trim();
          secret.value = typeof data.installed.client_secret === 'string' ? data.installed.client_secret.trim() : '';
          message.hidden = true;
        } catch (error) {
          warning(error instanceof SyntaxError ? 'The selected file does not contain valid JSON.' : errorText(error));
        }
      });
      form.append(element('p', 'help', 'In Google Cloud, enable the Google Calendar API and create an OAuth client of type Desktop app. Choose its downloaded JSON file or enter its details below.'),
        field('Desktop credentials JSON', file), field('Client ID', clientId), field('Client secret (optional)', secret),
        element('p', 'help', 'Google opens in your browser to finish sign-in.'));
    } else {
      form.append(element('p', 'help', 'Calendar Central reads calendars available in Apple Calendar on this Mac. Allow access when macOS asks.'));
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = { provider, name: connectionName.value.trim() || undefined };
      if (token) values.token = token.value.trim();
      if (clientId) values.clientId = clientId.value.trim();
      if (secret?.value) values.clientSecret = secret.value.trim();
      write('connect', values, () => { settings(); actions.toast('Connected to ' + name); });
    });
    body.append(form);
    const submit = element('button', 'primary', 'Connect');
    submit.type = 'submit';
    submit.setAttribute('form', form.id);
    footer.append(button('Back', settings), submit);
    (token || clientId || connectionName).focus();
  }

  function edit(item, defaults = {}) {
    const source = item && sourceOf(item);
    if (item && !source) return;
    const allowed = item ? editable(item, source) : true;
    const choices = item ? [source] : state().sources.filter(source => source.selected && writable(source));
    panel('editor', item ? (allowed ? 'Edit ' + (source.provider === 'ticktick' ? 'task' : 'event') : 'Item details') : 'New item');
    if (!choices.length) {
      body.append(element('p', '', 'Choose a writable TickTick list or Google calendar in Calendars to create an item.'));
      footer.append(button('Cancel', close), button('Manage calendars', settings, 'primary'));
      return;
    }
    if (!allowed) {
      body.append(element('strong', 'details-title', item.title), element('p', 'detail-dates', spanDescription(item)), element('p', 'help', source.name + ' · ' + providers[source.provider]));
      const reason = source.provider === 'ticktick' && item.recurring ? 'Open this recurring task in TickTick to change its schedule or completion.' :
        item.completed ? 'This task is complete.' : 'This item is read-only in Calendar Central.';
      body.append(element('p', 'inline-note', reason));
      if (source.provider !== 'ticktick') footer.append(button('Hide in Calendar Central', () => hide(item), 'text-button'));
      if (completable(item, source)) footer.append(button('Complete task', () => complete(item), 'primary'));
      footer.append(button('Done', close));
      return;
    }
    const day = defaults.day || actions.selectedDate();
    const now = Date.now();
    const initial = defaults.start ?? (day === localDate(now)
      ? Math.min(Math.ceil(now / (SLOT * MINUTE)) * SLOT * MINUTE, new Date(day + 'T23:45:00').getTime())
      : new Date(day + 'T09:00:00').getTime());
    const original = item || (defaults.allDay ? { allDay: true, start: day, end: addDays(day, 1) } : { allDay: false, start: asISO(initial), end: asISO(initial + 30 * MINUTE) });
    const form = element('form', 'editor-form');
    form.id = 'item-form';
    const title = input('text', 'item-title', item?.title || '');
    title.placeholder = 'Add a title';
    title.required = true;
    const destination = element('select');
    destination.id = 'item-calendar';
    for (const provider of Object.keys(providers)) {
      const subset = choices.filter(choice => choice.provider === provider);
      if (!subset.length) continue;
      const group = element('optgroup');
      group.label = providers[provider];
      for (const choice of subset) {
        const option = element('option', '', choice.name);
        option.value = choice.id;
        group.append(option);
      }
      destination.append(group);
    }
    destination.disabled = Boolean(item);
    const allDay = check('All day', original.allDay);
    allDay.control.id = 'all-day';
    const timing = element('div', 'timing-fields');
    const parts = {};
    for (const edge of ['start', 'end']) {
      const leading = edge === 'start' ? 'Start' : 'End';
      const value = original[edge];
      const date = input('date', edge + '-date', original.allDay ? (edge === 'end' ? addDays(value, -1) : value) : localDate(value));
      const time = input('time', edge + '-time', original.allDay ? (edge === 'start' ? '09:00' : '09:30') : localTime(value));
      date.required = time.required = true;
      date.min = '0001-01-01';
      date.max = '9999-12-31';
      const timeField = field(leading + ' time', time);
      const offset = element('select');
      offset.setAttribute('aria-label', leading + ' time offset');
      const offsetField = field(leading + ' time offset', offset);
      offsetField.classList.add('offset-field');
      const row = element('div', 'timing-row');
      row.append(field(leading + ' date', date), timeField, offsetField);
      timing.append(row);
      parts[edge] = { date, time, timeField, offset, offsetField };
    }
    const help = element('p', 'help timing-help');
    form.append(field('Title', title), field('Calendar', destination), allDay.row, timing, help);
    function updateTimes() {
      for (const edge of ['start', 'end']) {
        const { date, time, timeField, offset, offsetField } = parts[edge];
        timeField.hidden = allDay.control.checked;
        time.disabled = allDay.control.checked;
        const instants = possibleInstants(date.value, time.value);
        const previous = offset.value;
        offset.replaceChildren();
        for (const value of instants) {
          const option = element('option', '', zoneOffset(value));
          option.value = String(value);
          offset.append(option);
        }
        const originalMinute = !original.allDay && Math.floor(Date.parse(original[edge]) / MINUTE) * MINUTE;
        if (instants.includes(Number(previous)) && previous) offset.value = previous;
        else if (instants.includes(originalMinute)) offset.value = String(originalMinute);
        offsetField.hidden = allDay.control.checked || instants.length < 2;
      }
      help.textContent = allDay.control.checked ? 'End date is the last day included.' : Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ');
    }
    function readInstant(edge) {
      const { date, time, offset } = parts[edge];
      const values = possibleInstants(date.value, time.value);
      if (!values.length) throw new Error('Choose a local time that exists on the ' + edge + ' date.');
      const value = values.includes(Number(offset.value)) ? Number(offset.value) : values[0];
      if (!original.allDay && value === Math.floor(Date.parse(original[edge]) / MINUTE) * MINUTE) return original[edge];
      return asISO(value);
    }
    let endManuallyChanged = false;
    const duration = original.allDay ? 30 * MINUTE : Date.parse(original.end) - Date.parse(original.start);
    function followStart() {
      if (endManuallyChanged || !parts.start.date.value) { updateTimes(); return; }
      if (allDay.control.checked) {
        const span = original.allDay ? Math.max(0, differenceInDays(original.start, original.end) - 1) : 0;
        parts.end.date.value = addDays(parts.start.date.value, span);
      } else {
        const values = possibleInstants(parts.start.date.value, parts.start.time.value);
        if (values.length) {
          const chosen = values.includes(Number(parts.start.offset.value)) ? Number(parts.start.offset.value) : values[0];
          const end = chosen + duration;
          parts.end.date.value = localDate(end);
          parts.end.time.value = localTime(end);
          updateTimes();
          if ([...parts.end.offset.options].some(option => Number(option.value) === Math.floor(end / MINUTE) * MINUTE)) {
            parts.end.offset.value = String(Math.floor(end / MINUTE) * MINUTE);
          }
          return;
        }
      }
      updateTimes();
    }
    for (const control of [parts.end.date, parts.end.time, parts.end.offset]) {
      control.addEventListener('input', () => { endManuallyChanged = true; updateTimes(); });
    }
    for (const control of [parts.start.date, parts.start.time, parts.start.offset]) control.addEventListener('input', followStart);
    allDay.control.addEventListener('change', () => {
      if (allDay.control.checked && parts.end.time.value === '00:00' && parts.end.date.value > parts.start.date.value) {
        parts.end.date.value = addDays(parts.end.date.value, -1);
      }
      if (!allDay.control.checked && parts.start.date.value === parts.end.date.value && parts.end.time.value <= parts.start.time.value) {
        const start = possibleInstants(parts.start.date.value, parts.start.time.value)[0];
        if (start !== undefined) {
          const end = start + 30 * MINUTE;
          parts.end.date.value = localDate(end);
          parts.end.time.value = localTime(end);
        }
      }
      updateTimes();
    });
    updateTimes();
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      try {
        const name = title.value.trim();
        if (!name) throw new Error('Enter a title.');
        const all = allDay.control.checked;
        const start = all ? parts.start.date.value : readInstant('start');
        const end = all ? addDays(parts.end.date.value, 1) : readInstant('end');
        const isPoint = item && !item.allDay && Date.parse(item.end) === Date.parse(item.start);
        if (all ? end <= start : (Date.parse(end) < Date.parse(start) || (!isPoint && Date.parse(end) === Date.parse(start)))) throw new Error('End must be after start.');
        const data = { ...(item ? itemKey(item) : {}), title: name, sourceId: destination.value, start, end, allDay: all };
        if (!item && state().uncertain.some(row => row.sourceId === data.sourceId && row.title === name)) return uncertainItems();
        if (item && name === item.title && all === item.allDay && start === item.start && end === item.end) return close();
        save(item, data);
      } catch (error) { warning(errorText(error)); }
    });
    body.append(form);
    if (item && (item.recurring || item.hasAttendees)) {
      const descriptions = [item.recurring ? 'This is one occurrence of a recurring event.' : '', item.hasAttendees ? 'Google sends updates to the guests on this event.' : ''];
      body.append(element('p', 'inline-note', descriptions.filter(Boolean).join(' ')));
    }
    if (item && completable(item, source)) {
      const done = button('Complete task', () => complete(item), 'text-button left-action');
      form.addEventListener('input', () => { done.disabled = true; done.title = 'Save your edits before completing this task'; });
      footer.append(done);
    } else if (item && source.provider !== 'ticktick') {
      const more = element('details', 'more-actions');
      more.append(element('summary', '', 'More actions'));
      const options = element('div');
      options.append(button('Hide in Calendar Central', () => hide(item)));
      if (deletable(item, source)) options.append(button('Delete from Google', () => review('remove', item, itemKey(item)), 'danger-text'));
      more.append(options);
      footer.append(more);
    }
    const submit = element('button', 'primary', 'Save');
    submit.type = 'submit';
    submit.setAttribute('form', form.id);
    footer.append(button('Cancel', close), submit);
    title.focus();
  }

  function save(item, data) {
    if (item && sourceOf(item)?.provider === 'google' && (item.hasAttendees || item.recurring)) return review('save', item, data);
    submitSave(item, data);
  }
  function submitSave(item, data) {
    write('save', data, () => { close(); actions.toast(item ? 'Changes saved' : 'Item created'); }, text => {
      if (!item && state().uncertain.some(row => row.sourceId === data.sourceId && row.title === data.title)) {
        uncertainItems();
        return;
      }
      const retry = item ? { label: 'Open latest item', action: () => {
        const latest = latestItem(item);
        if (latest) edit(latest);
        else { close(); actions.report('This item is no longer in the displayed calendars.'); }
      } } : undefined;
      warning(text, retry);
    });
  }
  function review(method, item, data) {
    const back = returnToPanel();
    const remove = method === 'remove';
    panel('review', remove ? 'Delete from Google?' : 'Review Google event change', { back });
    const source = sourceOf(item);
    body.append(element('strong', 'details-title', item.title), element('p', 'help', source.name + ' · Google'));
    if (remove) {
      body.append(element('p', '', 'Delete this event from its Google calendar?'), element('p', 'detail-dates', spanDescription(item)));
    } else {
      const times = element('dl', 'review-times');
      times.append(element('dt', '', 'Current'), element('dd', '', spanDescription(item)), element('dt', '', 'New'), element('dd', '', spanDescription(data)));
      if (data.title !== item.title) times.append(element('dt', '', 'New title'), element('dd', '', data.title));
      body.append(times);
    }
    const checks = [];
    if (item.hasAttendees) {
      const guests = check('Notify guests');
      body.append(guests.row, element('p', 'help check-help', remove ? 'Google will send a cancellation to guests.' : 'Google will send the updated event to guests.'));
      checks.push(guests.control);
    }
    if (item.recurring) {
      const scope = check('Only this occurrence');
      body.append(scope.row, element('p', 'help check-help', 'Apply this change to the occurrence shown above.'));
      checks.push(scope.control);
    }
    const confirm = button(remove ? 'Delete from Google' : 'Save changes', () => {
      if (checks.some(control => !control.checked)) return;
      const payload = { ...data, notify: Boolean(item.hasAttendees), occurrence: Boolean(item.recurring) };
      if (remove) write('remove', payload, () => { close(); actions.toast('Deleted from Google'); });
      else submitSave(item, payload);
    }, remove ? 'destructive' : 'primary');
    const evaluate = () => { confirm.disabled = checks.some(control => !control.checked); };
    checks.forEach(control => control.addEventListener('change', evaluate));
    evaluate();
    footer.append(button('Cancel', back), confirm);
  }

  function hide(item) {
    write('hide', { id: item.id, sourceId: item.sourceId }, () => { close(); actions.toast('Hidden in Calendar Central'); });
  }
  function complete(item) {
    if (completable(item, sourceOf(item))) write('complete', itemKey(item), () => { close(); actions.toast('Task completed in TickTick'); });
  }
  function hiddenItems() {
    panel('hidden', 'Hidden items', { wide: true });
    const rows = state().hidden;
    body.append(element('p', 'help', rows.length ? 'These items stay on their source calendars. Restore an item to show it here again.' : 'No items are hidden. Use an item’s shortcut menu to hide it in Calendar Central.'));
    for (const row of rows) {
      const entry = element('div', 'review-entry');
      const info = element('div');
      info.append(element('strong', '', row.title), element('small', '', sourceOf(row)?.name || 'Calendar'));
      entry.append(info, button('Restore', () => write('restore', { id: row.id, sourceId: row.sourceId }, () => { hiddenItems(); actions.toast('Item restored'); })));
      body.append(entry);
    }
    footer.append(button('Done', close, 'primary'));
  }
  function uncertainItems() {
    panel('uncertain', 'Review unconfirmed writes', { wide: true });
    const rows = state().uncertain;
    body.append(element('p', 'help', rows.length ? 'Check each item in its source calendar before marking it reviewed. Creating it again can make a duplicate.' : 'Every write has been reviewed.'));
    for (const row of rows) {
      const entry = element('div', 'review-entry');
      const info = element('div');
      info.append(element('strong', '', row.title), element('small', '', sourceOf(row)?.name || 'Calendar'), element('p', 'help', row.message));
      entry.append(info, button('Mark reviewed', () => {
        panel('acknowledge', 'Mark write as reviewed?', { back: uncertainItems });
        body.append(element('strong', 'details-title', row.title), element('p', '', 'Confirm that you checked the source for this item. Calendar Central will clear this notice.'));
        footer.append(button('Cancel', uncertainItems), button('I checked the source', () => write('acknowledge', { id: row.id }, uncertainItems), 'primary'));
      }));
      body.append(entry);
    }
    footer.append(button('Done', close));
  }

  function closeMenu(restore = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (restore && menuOpener?.isConnected) menuOpener.focus({ preventScroll: true });
  }
  function itemMenu(item, x, y, trigger) {
    closeMenu(false);
    menuOpener = trigger;
    const source = sourceOf(item);
    const choices = [];
    const add = (label, action, danger = false) => {
      const option = button(label, () => { closeMenu(); action(); }, danger ? 'danger-text' : '');
      option.setAttribute('role', 'menuitem');
      choices.push(option);
    };
    add(editable(item, source) ? 'Edit item' : 'View details', () => edit(item));
    if (completable(item, source)) add('Complete task', () => complete(item));
    if (source.provider !== 'ticktick') add('Hide in Calendar Central', () => hide(item));
    if (deletable(item, source)) add('Delete from Google', () => review('remove', item, itemKey(item)), true);
    menu.replaceChildren(...choices);
    menu.hidden = false;
    menu.style.left = Math.max(6, Math.min(x, innerWidth - menu.offsetWidth - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, innerHeight - menu.offsetHeight - 6)) + 'px';
    choices[0].focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) closeMenu(false); });
  window.addEventListener('blur', () => closeMenu(false));
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') { closeMenu(); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const options = [...menu.querySelectorAll('button')];
    options[(options.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
  });
  function sync() {
    if (busy || !dialog.open) return;
    if (kind === 'settings') settings();
    else if (kind === 'hidden') hiddenItems();
    else if (kind === 'uncertain') uncertainItems();
  }
  return { edit, settings, hiddenItems, uncertainItems, menu: itemMenu, closeMenu, sync, reschedule: (item, change) => save(item, { ...itemKey(item), title: item.title, ...change }) };
}
