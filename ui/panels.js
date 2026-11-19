import { $, accountLabel, button, completable, deletable, editable, element, errorText, healthFor, icon, iconButton, providerMark, sourceColor, sourceContext, sourceCheckbox, tickTickCalendarCheckbox, writable } from './dom.js';
import { MINUTE, SLOT, addDays, differenceInDays, formatDate, localDate, localTime, possibleInstants, zoneOffset } from './dates.js';
import { showMacAccountPicker, showRetainedCalendars } from './mac-account-picker.js';
import { createTickTickEditor } from './ticktick-editor.js';
import { listCount, tickTickSections } from './ticktick-lists.js';
import { appearanceSettings } from './appearance.js';

const dateFormat = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
const asISO = value => new Date(value).toISOString();
const itemKey = item => ({ sourceId: item.sourceId, id: item.id, version: item.version });
const defaultNotifications = { enabled: false, leadMinutes: 10 };

function timingLabel(minutes) {
  if (minutes === 0) return 'At start';
  const unit = minutes % 1440 === 0 ? 'day' : minutes % 60 === 0 ? 'hour' : 'minute';
  const amount = minutes / { day: 1440, hour: 60, minute: 1 }[unit];
  return amount + ' ' + unit + (amount === 1 ? '' : 's') + ' before';
}

function bellIcon(enabled) {
  const mark = icon('bell');
  if (!enabled) mark.append(element('i'));
  return mark;
}

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
  const pendingNotifications = new Set();
  const state = () => actions.state();
  const integration = id => state().connectionOptions?.integrations.find(row => row.id === id);
  const providerName = id => integration(id)?.name || id;
  const brandName = id => id === 'google' ? 'Google' : providerName(id);
  const notificationsFor = id => state().notificationPreferences?.[id] || defaultNotifications;
  const sourceOf = item => state().sources.find(source => source.id === item.sourceId);
  const viaAppleCalendar = data => state().connections.some(connection => connection.id === sourceOf(data)?.connectionId && connection.provider === 'google' && connection.route === 'mac');
  const latestItem = item => state().items.find(entry => entry.id === item.id && entry.sourceId === item.sourceId);
  const hasPendingCreate = ({ sourceId, title }) => state().uncertain.some(row =>
    row.kind === 'create' && row.sourceId === sourceId && row.title === title);

  function displayedCalendar(source) {
    return source?.calendarId ? state().ticktickCalendars.find(calendar => calendar.id === source.calendarId) ?? source : source;
  }

  function markCalendar(node, calendar) {
    if (calendar) {
      node.classList.add('calendar-context');
      node.style.setProperty('--source-color', sourceColor(calendar));
    }
    return node;
  }

  function calendarContext(source, tag = 'p') {
    const calendar = displayedCalendar(source);
    const label = sourceContext(source, state().connections, calendar?.name);
    return markCalendar(element(tag, 'help', label), calendar);
  }

  function close() {
    if (dialog.open) dialog.close();
    kind = undefined;
    const target = opener?.isConnected ? opener : document.getElementById(opener?.id || '');
    target?.focus({ preventScroll: true });
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
    const scroll = dialog.open && kind === 'settings' ? body.scrollTop : 0;
    const focused = kind === 'settings' && document.activeElement.id;
    panel('settings', 'Calendars', { wide: true });
    const { connections, sources, ticktickCalendars, health } = state();
    body.append(appearanceSettings(), element('h3', 'settings-subhead', 'Add an account'));
    const options = element('div', 'provider-options');
    for (const { id, name, available } of state().connectionOptions?.integrations || []) {
      if (!available) continue;
      const connect = button('', () => connectionForm(id), 'provider-button');
      connect.setAttribute('aria-label', 'Connect ' + name);
      connect.append(providerMark(id), document.createTextNode(name), icon('plus'));
      options.append(connect);
    }
    body.append(options);
    if (connections.length) {
      const help = connections.some(row => row.provider === 'ticktick')
        ? 'Choose the calendars and task lists to show. Keep the TickTick copy calendar off when its original list is selected.'
        : 'Choose the calendars to show.';
      body.append(element('p', 'help', help));
    }
    for (const connection of connections) {
      const group = element('section', 'connection-group');
      const label = accountLabel(connection, connections);
      group.dataset.connectionId = connection.id;
      group.setAttribute('aria-label', label);
      const heading = element('div', 'connection-heading');
      const name = element('div', 'connection-name');
      const provider = providerMark(connection.provider);
      provider.title = providerName(connection.provider);
      name.append(provider, element('strong', '', label));
      const controls = element('div', 'connection-controls');
      if (connection.provider === 'google' && connection.route === 'mac') {
        controls.append(button('Choose calendars', () => chooseMacAccount('google', connection), 'text-button'));
      } else if (connection.provider === 'google' || integration(connection.provider)?.routes.some(route => route === 'browser' || route === 'token')) {
        controls.append(button('Reconnect', () => connectionForm(connection.provider, connection), 'text-button'));
      }
      controls.append(button('Rename', () => renameConnection(connection), 'text-button'),
        button('Disconnect', () => disconnect(connection), 'text-button subdued'));
      heading.append(name, controls);
      group.append(heading);
      const listed = sources.filter(source => source.connectionId === connection.id);
      if (connection.provider === 'ticktick') {
        for (const calendar of ticktickCalendars.filter(calendar => calendar.connectionId === connection.id)) {
          const row = element('div', 'settings-source');
          row.append(tickTickCalendarCheckbox(calendar, visible => {
            write('setTickTickCalendarVisible', { connectionId: connection.id, calendarId: calendar.id, visible }, settings, text => {
              settings();
              warning(text);
            });
          }, health), notificationSettingsButton(calendar));
          group.append(row);
        }
        const filter = element('div', 'settings-list-filter');
        filter.append(element('span', 'help', listCount(listed.filter(source => source.included).length) + ' included'),
          button('Edit lists', () => tickTickLists(connection.id, true), 'text-button'));
        group.append(filter);
        body.append(group);
        continue;
      }
      if (!listed.length) group.append(element('p', 'help', 'No calendars are available from this connection yet.'));
      for (const source of listed) {
        const row = element('div', 'settings-source');
        row.dataset.sourceId = source.id;
        const status = healthFor(source, health);
        row.append(sourceCheckbox(source, selected => setSource(source, { selected }), status));
        if (source.writable) {
          const policy = check('Read-only', source.readOnly);
          policy.row.classList.add('readonly-control');
          policy.control.setAttribute('aria-label', 'Read-only ' + source.name);
          policy.control.addEventListener('change', () => setSource(source, { readOnly: policy.control.checked }));
          row.append(policy.row);
        }
        row.append(notificationSettingsButton(source));
        if (status && status.state !== 'current' && status.message) row.append(element('p', 'source-error', status.message));
        group.append(row);
      }
      body.append(group);
    }
    footer.append(button('Hidden items', hiddenItems, 'text-button'), button('Done', close, 'primary'));
    body.scrollTop = scroll;
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  }

  function colorButton(calendar) {
    const name = 'Change color for ' + calendar.name;
    const control = button('', () => calendarColorPicker(calendar), 'icon-button calendar-color-button');
    control.id = 'calendar-color-' + encodeURIComponent(calendar.id);
    control.dataset.calendarId = calendar.id;
    const color = sourceColor(calendar);
    control.style.setProperty('--source-color', color);
    control.title = name;
    control.setAttribute('aria-label', name);
    control.setAttribute('aria-description', sourceContext(calendar, state().connections) + ' · ' + color);
    control.setAttribute('aria-haspopup', 'dialog');
    return control;
  }

  function calendarColorPicker(calendar) {
    panel('calendar-color', 'Calendar color');
    dialog.classList.add('color-dialog');
    const form = element('form', 'editor-form');
    form.id = 'calendar-color-form';
    const save = color => write('setCalendarColor', { calendarId: calendar.id, color }, close);
    const picker = input('color', 'picked-color', sourceColor(calendar));
    picker.setAttribute('aria-label', 'Pick a color');
    const hex = input('text', 'hex-color', picker.value);
    hex.required = true;
    hex.pattern = '#?[0-9a-fA-F]{6}';
    hex.maxLength = 7;
    hex.spellcheck = false;
    hex.title = 'Six hex digits, for example #3978C4';
    const hexValue = () => '#' + hex.value.replace(/^#/, '');
    hex.addEventListener('input', () => { if (hex.validity.valid) picker.value = hexValue(); });
    picker.addEventListener('input', () => { hex.value = picker.value; });
    const fields = element('div', 'calendar-color-fields');
    fields.append(picker, field('Hex color', hex));
    form.append(element('strong', 'settings-subhead', sourceContext(calendar, state().connections)), fields);
    form.addEventListener('submit', event => { event.preventDefault(); if (form.reportValidity()) save(hexValue()); });
    body.append(form);
    const reset = button('Use default color', () => save(null), 'text-button');
    reset.disabled = !calendar.hasCustomColor;
    const submit = element('button', 'primary', 'Save');
    submit.type = 'submit';
    submit.setAttribute('form', form.id);
    footer.append(reset, button('Cancel', close), submit);
    hex.focus();
    hex.select();
  }

  function notificationBell(calendar) {
    const preference = notificationsFor(calendar.id);
    const bell = button('', () => changeNotifications(calendar.id, { enabled: !notificationsFor(calendar.id).enabled }), 'icon-button notification-bell');
    bell.id = 'calendar-bell-' + encodeURIComponent(calendar.id);
    bell.dataset.calendarId = calendar.id;
    bell.setAttribute('aria-label', 'Notifications for ' + calendar.name);
    bell.setAttribute('aria-pressed', String(preference.enabled));
    bell.setAttribute('aria-busy', String(pendingNotifications.has(calendar.id)));
    bell.setAttribute('aria-haspopup', 'menu');
    bell.setAttribute('aria-keyshortcuts', 'Shift+F10');
    const timing = timingLabel(preference.leadMinutes);
    bell.setAttribute('aria-description', (preference.enabled ? 'On. ' : 'Muted. ') + timing + '. Press Shift+F10 for timing.');
    bell.title = (preference.enabled ? 'Mute notifications' : 'Enable notifications') + ' · ' + timing + '. Right-click for timing.';
    bell.append(bellIcon(preference.enabled));
    bell.addEventListener('contextmenu', event => {
      event.preventDefault();
      notificationMenu(calendar, event.clientX, event.clientY, bell);
    });
    bell.addEventListener('keydown', event => {
      if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
      event.preventDefault();
      const rect = bell.getBoundingClientRect();
      notificationMenu(calendar, rect.left, rect.bottom, bell);
    });
    return bell;
  }

  async function changeNotifications(calendarId, patch) {
    if (pendingNotifications.has(calendarId)) return;
    pendingNotifications.add(calendarId);
    const id = 'calendar-bell-' + encodeURIComponent(calendarId);
    document.getElementById(id)?.setAttribute('aria-busy', 'true');
    try { await actions.mutate('setCalendarNotifications', { calendarId, ...patch }); }
    catch (error) { actions.report(errorText(error)); }
    finally {
      pendingNotifications.delete(calendarId);
      document.getElementById(id)?.setAttribute('aria-busy', 'false');
    }
  }

  function notificationSettingsButton(calendar) {
    const preference = notificationsFor(calendar.id);
    const open = button('', () => notificationSettings(calendar, true), 'notification-settings');
    open.id = 'calendar-notification-settings-' + encodeURIComponent(calendar.id);
    open.dataset.calendarId = calendar.id;
    open.title = 'Notification settings for ' + calendar.name;
    open.setAttribute('aria-label', open.title);
    const status = preference.enabled ? timingLabel(preference.leadMinutes) : 'Muted';
    open.setAttribute('aria-description', status);
    open.append(bellIcon(preference.enabled), document.createTextNode(status));
    return open;
  }

  function notificationSettings(calendar, fromSettings = false) {
    const scroll = fromSettings ? body.scrollTop : 0;
    function back() {
      if (!fromSettings) return close();
      settings();
      body.scrollTop = scroll;
      document.getElementById('calendar-notification-settings-' + encodeURIComponent(calendar.id))?.focus({ preventScroll: true });
    }
    const previous = notificationsFor(calendar.id);
    panel('notifications', 'Calendar notifications', { back });
    const form = element('form', 'editor-form');
    form.id = 'notification-form';
    const toggle = check('Enable notifications', previous.enabled);
    const lead = input('number', 'notification-lead', previous.leadMinutes);
    lead.min = '0';
    lead.max = '10080';
    lead.step = '1';
    lead.required = true;
    form.append(element('strong', 'settings-subhead', sourceContext(calendar, state().connections)), toggle.row, field('Minutes before start', lead),
      element('p', 'help', 'Use 0 to be notified when a timed item starts.'));
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const patch = {};
      if (toggle.control.checked !== previous.enabled) patch.enabled = toggle.control.checked;
      if (lead.valueAsNumber !== previous.leadMinutes) patch.leadMinutes = lead.valueAsNumber;
      if (!Object.keys(patch).length) return back();
      write('setCalendarNotifications', { calendarId: calendar.id, ...patch }, back);
    });
    body.append(form);
    const submit = element('button', 'primary', 'Save');
    submit.type = 'submit';
    submit.setAttribute('form', form.id);
    footer.append(button('Cancel', back), submit);
    lead.focus({ preventScroll: true });
  }

  function notificationMenu(calendar, x, y, trigger) {
    const preference = notificationsFor(calendar.id);
    const choices = [0, 5, 10, 15, 30, 60].map(minutes => {
      const option = button(timingLabel(minutes), () => {
        closeMenu();
        if (minutes !== notificationsFor(calendar.id).leadMinutes) void changeNotifications(calendar.id, { leadMinutes: minutes });
      });
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-label', timingLabel(minutes));
      option.setAttribute('aria-checked', String(minutes === preference.leadMinutes));
      return option;
    });
    const custom = button('Custom lead time…', () => { closeMenu(); notificationSettings(calendar); });
    custom.setAttribute('role', 'menuitem');
    choices.push(custom);
    showMenu('Notification timing', choices, x, y, trigger);
  }
  function tickTickLists(connectionId, fromSettings = false) {
    const connection = state().connections.find(connection => connection.id === connectionId);
    if (!connection) return settings();
    const cancel = fromSettings ? settings : close;
    let editor;
    panel('ticktick', 'TickTick calendars', { wide: true, back: () => editor.back() });
    dialog.classList.add('ticktick-dialog');
    editor = createTickTickEditor({
      connection, sources: state().sources.filter(source => source.connectionId === connectionId),
      heading: $('#dialog-title'), body, footer, cancel, clearError: () => { message.hidden = true; },
      save: patch => write('configureTickTick', { connectionId, ...patch }, cancel)
    });
  }
  function setSource(source, patch) {
    write('setSource', { sourceId: source.id, ...patch }, settings, text => {
      settings();
      warning(text);
    });
  }
  function disconnect(connection) {
    panel('disconnect', 'Disconnect calendar?', { back: settings });
    body.append(element('p', '', 'Remove ' + (connection.name || providerName(connection.provider)) + ' from Calendar Hub? Its tasks and events stay with the provider.'));
    footer.append(button('Cancel', settings), button('Disconnect', () => write('disconnect', { connectionId: connection.id }, settings), 'destructive'));
  }
  function renameConnection(connection) {
    panel('rename', 'Rename account', { back: settings });
    const form = element('form', 'editor-form');
    form.id = 'rename-form';
    const name = input('text', 'account-name', connection.name);
    name.required = true;
    form.append(field('Account name', name));
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!name.value.trim()) return warning('Enter an account name.');
      write('renameConnection', { connectionId: connection.id, name: name.value.trim() }, settings);
    });
    const save = element('button', 'primary', 'Save');
    save.type = 'submit';
    save.setAttribute('form', form.id);
    body.append(form);
    footer.append(button('Cancel', settings), save);
    name.select();
  }
  function optionalName(value = '') {
    const name = input('text', 'connection-name', value);
    name.placeholder = 'e.g. Work';
    return name;
  }
  function connectionForm(provider, connection, initialName = '') {
    if (provider === 'exchange') return chooseMacAccount(provider);
    const routes = integration(provider)?.routes || [];
    if (routes.includes('token') && !routes.includes('browser')) return advancedConnection(provider, connection, initialName, 'token');
    const name = providerName(provider);
    panel('connect', (connection ? 'Reconnect ' : 'Connect ') + name, { back: settings });
    footer.append(button('Back', settings));
    const accountName = !connection && provider !== 'mac' ? optionalName(initialName) : null;
    const values = () => connection ? { provider, connectionId: connection.id } :
      { provider, ...(accountName?.value.trim() && { name: accountName.value.trim() }) };
    if (provider === 'ticktick') {
      body.append(element('p', 'help', connection ? 'Sign in with the same TickTick account to keep the lists and settings for ' + connection.name + '. A dated Inbox task can help TickTick identify your account.' :
        'Sign in at TickTick and allow Calendar Hub to read and update your tasks.'));
      if (accountName) body.append(field('Account name (optional)', accountName));
      body.append(button('Use a personal token', () => advancedConnection(provider, connection, accountName?.value, 'token'), 'text-button'));
      footer.append(button('Continue with TickTick', () => finishConnection(values()), 'primary'));
    } else if (provider === 'mac') {
      body.append(element('p', 'help', 'Show meetings from Apple Calendar as read-only. Allow Calendar Hub to read your calendars when macOS asks.'));
      footer.append(button('Choose Mac calendars', () => finishConnection(values()), 'primary'));
    } else if (provider === 'google') {
      const { googleBrowser, macCalendars, googleConfigError } = state().connectionOptions;
      const nativePicker = () => chooseMacAccount(provider, undefined, accountName?.value);
      if (googleBrowser || connection) {
        body.append(element('p', 'help', connection ? 'Sign in to the same Google account to reconnect ' + connection.name + '.' :
          'Sign in at Google and choose the calendars to show here.'));
        if (accountName) body.append(field('Account name (optional)', accountName));
        footer.append(button('Continue with Google', () => finishConnection(values()), 'primary'));
        if (macCalendars && !connection) body.append(button('Use Google from Apple Calendar', nativePicker, 'text-button'));
      } else if (macCalendars) {
        body.append(element('p', 'help', 'Choose a Google account from Apple Calendar. You can add another account in Mac System Settings.'));
        footer.append(button('Choose Google calendars on this Mac', nativePicker, 'primary'));
      }
      body.append(button('Use your own Google desktop client', () => advancedConnection(provider, connection, accountName?.value, 'custom'), 'text-button'));
      if (googleConfigError && !googleBrowser) warning(googleConfigError);
    } else if (routes.includes('browser')) {
      body.append(element('p', 'help', connection ? 'Sign in to the same account to reconnect ' + connection.name + '.' :
        'Sign in at ' + name + ' to choose what to show in Calendar Hub.'));
      if (accountName) body.append(field('Account name (optional)', accountName));
      if (routes.includes('token')) body.append(button('Use an access token', () => advancedConnection(provider, connection, accountName?.value, 'token'), 'text-button'));
      footer.append(button('Continue with ' + name, () => finishConnection({ ...values(), route: 'browser' }), 'primary'));
    } else {
      warning('No sign-in method is available for ' + name + '.');
    }
  }
  function finishConnection(values) {
    write('connect', values, () => {
      settings();
      actions.toast(values.connectionId && values.route === 'mac' ? 'Calendar selection saved' :
        (values.connectionId ? 'Reconnected to ' : 'Connected to ') + providerName(values.provider));
    });
  }
  async function chooseMacAccount(provider, connection, initialName = '') {
    const google = provider === 'google';
    const brand = google ? 'Google' : 'Exchange';
    const name = connection ? null : optionalName(initialName);
    const back = connection || !google ? settings : () => connectionForm(provider, undefined, name?.value);
    panel('mac-account', google ? 'Choose Google calendars' : 'Connect Exchange', { back });
    const target = body;
    body.append(element('p', 'help', 'Looking for accounts in Apple Calendar…'));
    footer.append(button('Back', back));
    const retry = () => chooseMacAccount(provider, connection, name?.value);
    const openAccounts = button('Open Internet Accounts', async () => {
      try { await window.calendar.openInternetAccounts(); }
      catch (error) { warning(errorText(error)); }
    }, 'text-button');
    let rows;
    try { rows = await window.calendar.macAccountCalendars({ provider, ...(connection && { connectionId: connection.id }) }); }
    catch (error) {
      if (body !== target || !dialog.open) return;
      body.replaceChildren();
      if (error.code === 'PERMISSION') body.append(element('p', 'help', 'Allow Calendar Hub in System Settings under Privacy & Security → Calendars.'));
      footer.append(button('Check again', retry));
      warning(errorText(error));
      return;
    }
    if (body !== target || !dialog.open) return;
    const available = rows.filter(row => !row.unavailable);
    const retained = connection && google ? rows.filter(row => row.unavailable && row.chosen) : [];
    const missingAccount = connection && (connection.legacyMac ? !available.length :
      !available.some(row => row.accountId === connection.accountId));
    if (missingAccount || !available.length || !connection && available.every(row => row.connected)) {
      let help = 'Add ' + brand + ' in System Settings → Internet Accounts, turn on Calendars, then check again.';
      if (missingAccount) help = 'This account is unavailable in Apple Calendar. Check its Internet Accounts settings and turn on Calendars.';
      else if (available.length) help = 'These accounts are already connected. To add another ' + brand + ' account, open Internet Accounts and turn on Calendars.';
      body.replaceChildren(element('p', 'help', help));
      showRetainedCalendars(body, retained, connection?.legacyMac);
      body.append(openAccounts);
      footer.append(button('Check again', retry, 'primary'));
      return;
    }
    const help = connection ? 'Choose the Google calendars for ' + accountLabel(connection, state().connections) + '.' :
      google ? 'Apple Calendar also lists other CalDAV accounts, including iCloud. Choose the account you use with Google, then select its calendars.' :
        'Choose an Exchange account from Apple Calendar. Its calendars are read-only in Calendar Hub.';
    body.replaceChildren(element('p', 'help', help));
    showMacAccountPicker({ body, footer, provider, connection, rows: available, retained, nameField: name, connect: finishConnection });
    showRetainedCalendars(body, retained, connection?.legacyMac);
    if (name) body.append(field('Account name (optional)', name));
    const more = element('div', 'mac-account-tools');
    more.append(openAccounts, button('Check again', retry, 'text-button'));
    body.append(more);
  }
  function advancedConnection(provider, connection, initialName, route) {
    const connectionName = connection ? null : optionalName(initialName);
    const back = route === 'token' && !integration(provider).routes.includes('browser') ? settings :
      () => connectionForm(provider, connection, connectionName?.value);
    const title = route === 'token' ? (provider === 'ticktick' ? 'Use a TickTick token' : providerName(provider) + ' access token') : 'Use a Google desktop client';
    panel('connect-advanced', title, { back });
    const form = element('form', 'editor-form');
    form.id = 'connect-form';
    if (connectionName) form.append(field('Account name (optional)', connectionName));
    let token, clientId, secret;
    if (route === 'token') {
      token = input('password', 'access-token');
      token.autocomplete = 'off';
      token.spellcheck = false;
      token.autocapitalize = 'none';
      token.required = true;
      form.append(field('Access token', token));
      if (provider === 'ticktick') form.append(element('p', 'help', 'Use a TickTick Open API access token with task read and write access.'));
      if (connection) form.append(element('p', 'help', 'Use a token for the same account to reconnect ' + connection.name + '.'));
    } else {
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
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = { provider, route: route === 'custom' ? 'browser' : route, name: connectionName?.value.trim() || undefined, connectionId: connection?.id };
      if (token) {
        values.token = token.value.trim();
        if (!values.token) return warning('Enter an access token.');
      }
      if (clientId) values.clientId = clientId.value.trim();
      if (secret?.value) values.clientSecret = secret.value.trim();
      finishConnection(values);
    });
    body.append(form);
    const submit = element('button', 'primary', connection ? 'Reconnect' : 'Connect');
    submit.type = 'submit';
    submit.setAttribute('form', form.id);
    footer.append(button('Back', back), submit);
    (token || clientId || connectionName).focus();
  }

  function edit(item, defaults = {}) {
    const source = item && sourceOf(item);
    if (item && !source) return;
    const allowed = item ? editable(item, source) : true;
    const appointment = !item && defaults.kind === 'appointment';
    const choices = item ? [source] : state().sources.filter(choice =>
      choice.selected && writable(choice) && (!appointment || choice.itemKind === 'event'));
    const newTitle = appointment ? 'New appointment' : 'New item';
    panel('editor', item ? (allowed ? 'Edit ' + source.itemKind : 'Item details') : newTitle);
    if (!choices.length) {
      body.append(element('p', '', appointment
        ? 'Select a writable event calendar in Manage calendars to create an appointment.'
        : 'Choose a writable calendar or task list in Calendars to create an item.'));
      footer.append(button('Cancel', close), button('Manage calendars', settings, 'primary'));
      return;
    }
    if (!allowed) {
      body.append(element('strong', 'details-title', item.title), element('p', 'detail-dates', spanDescription(item)), calendarContext(source));
      const reason = source.itemKind === 'task' && item.recurring ? 'Open this recurring task in ' + brandName(source.provider) + ' to change its schedule or completion.' :
        item.completed ? 'This task is complete.' : 'This item is read-only in Calendar Hub.';
      body.append(element('p', 'inline-note', reason));
      if (source.itemKind === 'event') footer.append(button('Hide in Calendar Hub', () => hide(item), 'text-button'));
      if (completable(item, source)) footer.append(button('Complete task', () => complete(item), 'primary'));
      footer.append(button('Done', close));
      return;
    }
    const day = defaults.day || actions.selectedDate();
    const now = Date.now();
    const initial = defaults.start ?? (day === localDate(now)
      ? Math.min(Math.ceil(now / (SLOT * MINUTE)) * SLOT * MINUTE, new Date(day + 'T23:45:00').getTime())
      : new Date(day + 'T09:00:00').getTime());
    const original = item || (defaults.allDay
      ? { allDay: true, start: day, end: defaults.end ?? addDays(day, 1) }
      : { allDay: false, start: asISO(initial), end: asISO(defaults.end ?? initial + 30 * MINUTE) });
    const form = element('form', 'editor-form');
    form.id = 'item-form';
    const title = input('text', 'item-title', item?.title || '');
    title.placeholder = 'Add a title';
    title.required = true;
    const destination = element('select');
    destination.id = 'item-calendar';
    function addGroup(label, sources, connectionId, folderId) {
      const group = element('optgroup');
      group.label = label;
      if (connectionId) group.dataset.connectionId = connectionId;
      if (folderId) group.dataset.folderId = folderId;
      for (const source of sources) {
        const option = element('option', '', source.name);
        option.value = source.id;
        group.append(option);
      }
      destination.append(group);
    }
    for (const connection of state().connections) {
      const subset = choices.filter(source => source.connectionId === connection.id);
      if (!subset.length) continue;
      const name = accountLabel(connection, state().connections);
      const provider = providerName(connection.provider);
      const account = name === provider ? name : provider + ' · ' + name;
      if (connection.provider !== 'ticktick') {
        addGroup(account, subset, connection.id);
        continue;
      }
      for (const section of tickTickSections(subset)) {
        addGroup(section.id ? account + ' / ' + section.name : account, section.sources, connection.id, section.id);
      }
    }
    destination.disabled = Boolean(item);
    const destinationLabel = item || appointment ? (source?.itemKind === 'task' ? providerName(source.provider) + ' list' : 'Calendar') : 'Calendar or task list';
    const destinationField = field(destinationLabel, destination);
    const location = element('span', 'help destination-context');
    destinationField.append(location);
    function showDestination() {
      const group = destination.selectedOptions[0]?.parentElement;
      location.hidden = !group?.dataset.connectionId;
      location.textContent = location.hidden ? '' : group.label;
      markCalendar(location, displayedCalendar(choices.find(choice => choice.id === destination.value)));
    }
    destination.addEventListener('change', showDestination);
    showDestination();
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
    form.append(field('Title', title), destinationField, allDay.row, timing, help);
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
        if (!item && hasPendingCreate(data)) return uncertainItems();
        if (item && name === item.title && all === item.allDay && start === item.start && end === item.end) return close();
        save(item, data);
      } catch (error) { warning(errorText(error)); }
    });
    body.append(form);
    if (item && (item.recurring || item.hasAttendees)) {
      const descriptions = [item.recurring ? 'This is one occurrence of a recurring event.' : '', item.hasAttendees ? brandName(source.provider) + ' sends updates to the guests on this event.' : ''];
      body.append(element('p', 'inline-note', descriptions.filter(Boolean).join(' ')));
    }
    if (item && completable(item, source)) {
      const done = button('Complete task', () => complete(item), 'text-button left-action');
      form.addEventListener('input', () => { done.disabled = true; done.title = 'Save your edits before completing this task'; });
      footer.append(done);
    } else if (item && source.itemKind === 'event') {
      const more = element('details', 'more-actions');
      more.append(element('summary', '', 'More actions'));
      const options = element('div');
      options.append(button('Hide in Calendar Hub', () => hide(item)));
      if (deletable(item, source)) options.append(button('Delete from ' + brandName(source.provider), () => review('remove', item, itemKey(item)), 'danger-text'));
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
    if (item && sourceOf(item)?.itemKind === 'event' && (item.hasAttendees || item.recurring)) return review('save', item, data);
    submitSave(item, data);
  }
  function submitSave(item, data) {
    write('save', data, () => { close(); actions.toast(viaAppleCalendar(data) ? 'Saved in Apple Calendar for sync to Google' : item ? 'Changes saved' : 'Item created'); }, text => {
      if (!item && hasPendingCreate(data)) {
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
    const source = sourceOf(item);
    const brand = brandName(source.provider);
    panel('review', remove ? 'Delete from ' + brand + '?' : 'Review ' + brand + ' event change', { back });
    body.append(element('strong', 'details-title', item.title), calendarContext(source));
    if (remove) {
      body.append(element('p', '', 'Delete this event from its ' + brand + ' calendar?'), element('p', 'detail-dates', spanDescription(item)));
    } else {
      const times = element('dl', 'review-times');
      times.append(element('dt', '', 'Current'), element('dd', '', spanDescription(item)), element('dt', '', 'New'), element('dd', '', spanDescription(data)));
      if (data.title !== item.title) times.append(element('dt', '', 'New title'), element('dd', '', data.title));
      body.append(times);
    }
    const checks = [];
    if (item.hasAttendees) {
      const guests = check('Notify guests');
      const guestMessage = viaAppleCalendar(item) ? 'Apple Calendar and Google handle delivery to guests when they sync.' :
        brand + (remove ? ' will send a cancellation to guests.' : ' will send the updated event to guests.');
      body.append(guests.row, element('p', 'help check-help', guestMessage));
      checks.push(guests.control);
    }
    if (item.recurring) {
      const scope = check('Only this occurrence');
      body.append(scope.row, element('p', 'help check-help', 'Apply this change to the occurrence shown above.'));
      checks.push(scope.control);
    }
    const confirm = button(remove ? 'Delete from ' + brand : 'Save changes', () => {
      if (checks.some(control => !control.checked)) return;
      const payload = { ...data, notify: Boolean(item.hasAttendees), occurrence: Boolean(item.recurring) };
      if (remove) write('remove', payload, () => { close(); actions.toast(viaAppleCalendar(item) ? 'Deleted in Apple Calendar for sync to Google' : 'Deleted from ' + brand); });
      else submitSave(item, payload);
    }, remove ? 'destructive' : 'primary');
    const evaluate = () => { confirm.disabled = checks.some(control => !control.checked); };
    checks.forEach(control => control.addEventListener('change', evaluate));
    evaluate();
    footer.append(button('Cancel', back), confirm);
  }

  function hide(item) {
    write('hide', { id: item.id, sourceId: item.sourceId }, () => { close(); actions.toast('Hidden in Calendar Hub'); });
  }
  function complete(item) {
    if (completable(item, sourceOf(item))) write('complete', itemKey(item), () => { close(); actions.toast('Task completed in ' + brandName(sourceOf(item)?.provider)); });
  }
  function hiddenItems() {
    panel('hidden', 'Hidden items', { wide: true });
    const rows = state().hidden;
    body.append(element('p', 'help', rows.length ? 'These items stay on their source calendars. Restore an item to show it here again.' : 'No items are hidden. Use an item’s shortcut menu to hide it in Calendar Hub.'));
    for (const row of rows) {
      const entry = element('div', 'review-entry');
      const info = element('div');
      info.append(element('strong', '', row.title), calendarContext(sourceOf(row), 'small'));
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
      info.append(element('strong', '', row.title), calendarContext(sourceOf(row), 'small'), element('p', 'help', row.message));
      entry.append(info, button('Mark reviewed', () => {
        panel('acknowledge', 'Mark write as reviewed?', { back: uncertainItems });
        body.append(element('strong', 'details-title', row.title), element('p', '', 'Confirm that you checked the source for this item. Calendar Hub will clear this notice.'));
        footer.append(button('Cancel', uncertainItems), button('I checked the source', () => write('acknowledge', { id: row.id }, uncertainItems), 'primary'));
      }));
      body.append(entry);
    }
    footer.append(button('Done', close));
  }

  function closeMenu(restore = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (restore) {
      const target = menuOpener?.isConnected ? menuOpener : document.getElementById(menuOpener?.id || '');
      target?.focus({ preventScroll: true });
    }
  }
  function showMenu(label, choices, x, y, trigger) {
    closeMenu(false);
    menuOpener = trigger;
    menu.setAttribute('aria-label', label);
    menu.replaceChildren(...choices);
    menu.hidden = false;
    menu.style.left = Math.max(6, Math.min(x, innerWidth - menu.offsetWidth - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, innerHeight - menu.offsetHeight - 6)) + 'px';
    (choices.find(choice => choice.getAttribute('aria-checked') === 'true') || choices[0]).focus({ preventScroll: true });
  }
  function itemMenu(item, x, y, trigger) {
    const source = sourceOf(item);
    const choices = [];
    const add = (label, action, danger = false) => {
      const option = button(label, () => { closeMenu(); action(); }, danger ? 'danger-text' : '');
      option.setAttribute('role', 'menuitem');
      choices.push(option);
    };
    add(editable(item, source) ? 'Edit item' : 'View details', () => edit(item));
    if (completable(item, source)) add('Complete task', () => complete(item));
    if (source.itemKind === 'event') add('Hide in Calendar Hub', () => hide(item));
    if (deletable(item, source)) add('Delete from ' + brandName(source.provider), () => review('remove', item, itemKey(item)), true);
    showMenu('Item actions', choices, x, y, trigger);
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
  return { edit, settings, colorButton, notificationBell, tickTickLists, hiddenItems, uncertainItems, menu: itemMenu, closeMenu, sync, reschedule: (item, change) => save(item, { ...itemKey(item), title: item.title, ...change }) };
}
