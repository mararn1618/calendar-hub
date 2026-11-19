import { addDays, dateRangeLabel, formatDate, localDate, localTime, monday, monthStart, weekNumber } from './dates.js';
import { $, accountLabel, button, element, errorText, healthFor, icon, iconButton, labelNativeSources, sourceContext, sourceCheckbox, tickTickCalendarCheckbox } from './dom.js';
import { createPanels } from './panels.js';
import { createPlanner } from './planner.js';
import { macCalendarAccess, syncIssues } from './sync-issues.js';
import { calendarAction } from './calendar-client.js';

const emptyState = { connections: [], sources: [], ticktickCalendars: [], items: [], hidden: [], health: [], uncertain: [], notificationPreferences: {}, notificationError: null };
let data = emptyState;
let selectedDate = localDate();
let month = monthStart(selectedDate);
let today = selectedDate;
let zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let view = ['day', 'week', 'next'].includes(localStorage.getItem('view')) ? localStorage.getItem('view') : 'day';
const savedCount = Number(localStorage.getItem('next-days'));
let count = Number.isInteger(savedCount) && savedCount >= 1 && savedCount <= 31 ? savedCount : 3;
let loadedRange = '';
let displayedRange = '';
let loadError = '';
let notice;
let sequence = 0;
let pending;
let refreshCount = 0;
let tickTickTimer;
let toastTimer;
let recheckOnReturn;
let requestingMacAccess = false;
const pendingSchedules = new Map();
const scheduleKey = (sourceId, id) => JSON.stringify([sourceId, id]);
let scrollToWorkdayOnRender = false;
const viewport = $('#timeline');
viewport.dataset.refreshCount = '0';

function range() {
  const start = view === 'week' ? monday(selectedDate) : selectedDate;
  const size = view === 'day' ? 1 : view === 'week' ? 7 : count;
  return { start, end: addDays(start, size), days: Array.from({ length: size }, (_, index) => addDays(start, index)) };
}
const rangeKey = period => [zone, period.start, period.end].join('/');

function toast(text) {
  clearTimeout(toastTimer);
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 3300);
}

function report(text, action) {
  notice = { text, action };
  renderStatus();
}

const panels = createPanels({
  state: () => data, selectedDate: () => selectedDate, beginSchedule, mutate, report, toast, refresh: refreshCalendars,
  macAccessButtons, refreshMacCalendars
});
const planner = createPlanner(viewport, {
  selectDay: day => goTo(day, 'day'), navigate, edit: panels.edit, create: defaults => panels.edit(undefined, defaults),
  menu: panels.menu, reschedule: panels.reschedule, reviewWrites: item => {
    if (data.uncertain.some(row => row.sourceId === item.sourceId && row.targetId === item.id)) panels.uncertainItems();
    else void refreshCalendars();
  }
});

function renderMini() {
  $('#mini-heading').textContent = formatDate(month, { month: 'long', year: 'numeric' });
  const first = monday(month);
  const { start, end } = range();
  const days = [];
  for (let index = 0; index < 42; index++) {
    const day = addDays(first, index);
    const node = button(String(Number(day.slice(-2))), () => goTo(day), 'mini-date');
    node.dataset.date = day;
    node.setAttribute('aria-label', formatDate(day, { dateStyle: 'full' }));
    node.setAttribute('aria-pressed', String(day === selectedDate));
    if (day === today) { node.classList.add('today'); node.setAttribute('aria-current', 'date'); }
    if (day === selectedDate) node.classList.add('selected');
    else if (day >= start && day < end) node.classList.add('in-range');
    if (day.slice(0, 7) !== month.slice(0, 7)) node.classList.add('other-month');
    days.push(node);
  }
  $('#mini-days').replaceChildren(...days);
}
function renderDayCount() {
  $('#day-count').value = String(count);
  $('[data-view="next"]').textContent = `Next ${count} ${count === 1 ? 'Day' : 'Days'}`;
}
function renderHeading() {
  const { days, start } = range();
  $('#range-title').textContent = dateRangeLabel(start, days.at(-1));
  $('#range-context').textContent = `Week ${weekNumber(selectedDate)} · ${selectedDate.slice(0, 4)}`;
  $('#count-control').hidden = view !== 'next';
  for (const node of document.querySelectorAll('[data-view]')) node.setAttribute('aria-pressed', String(node.dataset.view === view));
  $('#zone-name').textContent = zone.replaceAll('_', ' ').replaceAll('/', ' / ');
  renderMini();
}
function renderSources() {
  const list = $('#source-list');
  const focused = list.contains(document.activeElement) ? document.activeElement.id : '';
  const groups = [];
  function calendarRow(calendar, checkbox) {
    const row = element('div', 'sidebar-calendar-row');
    row.append(checkbox, panels.colorButton(calendar), panels.notificationBell(calendar));
    return row;
  }
  for (const [provider, accounts] of Map.groupBy(data.connections, row => row.provider)) {
    const section = element('section', 'sidebar-provider');
    const header = element('div', 'sidebar-calendar-heading');
    const title = element('h3', '', accounts[0].providerName || provider);
    title.id = 'sidebar-provider-' + provider;
    section.setAttribute('aria-labelledby', title.id);
    header.append(title);
    section.append(header);
    for (const connection of accounts) {
      const label = accountLabel(connection, data.connections);
      const group = element('div', 'sidebar-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      const calendars = data.ticktickCalendars.filter(calendar => calendar.connectionId === connection.id);
      const singleAccountRow = connection.ticktick?.mode === 'account' && calendars.length === 1 && calendars[0].name === label;
      const accountHeader = element('div', 'sidebar-calendar-heading');
      if (!singleAccountRow && label !== title.textContent) {
        const name = element('h4', '', label);
        name.title = label;
        accountHeader.append(name);
      }
      if (provider === 'ticktick') {
        const configure = iconButton('Edit TickTick lists', 'settings', () => panels.tickTickLists(connection.id));
        configure.id = 'edit-ticktick-' + connection.id;
        configure.dataset.connectionId = connection.id;
        configure.title = 'Edit lists for ' + label;
        const rows = calendars.map(calendar => calendarRow(calendar, tickTickCalendarCheckbox(calendar, async visible => {
          try { await mutate('setTickTickCalendarVisible', { connectionId: connection.id, calendarId: calendar.id, visible }); }
          catch (error) { report(errorText(error)); renderSources(); }
        }, data.health)));
        const controls = accounts.length === 1 ? header : singleAccountRow ? rows[0] : accountHeader;
        controls.append(configure);
        group.append(...rows);
      } else {
        for (const source of data.sources.filter(source => source.connectionId === connection.id)) {
          group.append(calendarRow(source, sourceCheckbox(source, async selected => {
            try { await mutate('setSource', { sourceId: source.id, selected }); }
            catch (error) { report(errorText(error)); renderSources(); }
          }, healthFor(source, data.health))));
        }
      }
      if (accountHeader.childElementCount) group.prepend(accountHeader);
      section.append(group);
    }
    groups.push(section);
  }
  if (!groups.length) {
    const add = button('', panels.settings, 'add-calendar');
    add.append(icon('plus'), document.createTextNode('Add a connection'));
    groups.push(add);
  }
  list.replaceChildren(...groups);
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
}

function banner(text, action, dismiss = false, alert = true) {
  const row = element('div', 'notice');
  row.setAttribute('role', alert ? 'alert' : 'status');
  row.append(element('span', 'notice-symbol', '!'), element('span', 'notice-text', text));
  if (action) row.append(button(action.label, action.action, 'text-button'));
  if (dismiss) row.append(iconButton('Dismiss message', 'close', () => { notice = undefined; renderStatus(); }));
  return row;
}
function macAccessButtons(access, check = refreshMacCalendars, showError = report) {
  function recheck() {
    recheckOnReturn = undefined;
    return check();
  }
  async function open() {
    if (access.request) {
      if (requestingMacAccess) return;
      requestingMacAccess = true;
      try { await calendarAction('requestCalendarAccess'); }
      catch (error) { if (!macCalendarAccess(error.code)) showError(errorText(error)); }
      try { await recheck(); }
      finally { requestingMacAccess = false; }
      return;
    }
    recheckOnReturn = recheck;
    try { await calendarAction('openCalendarPrivacy'); }
    catch {
      recheckOnReturn = undefined;
      showError('Open System Settings > Privacy & Security > Calendars.');
    }
  }
  return [button(access.label, open, 'text-button calendar-access-action'), button('Check access', recheck, 'text-button')];
}

function renderStatus() {
  const { summary, macAccess, accounts, onlyTickTickPaused } = syncIssues(data);
  const latest = data.health.map(h => h.checkedAt).filter(Boolean).sort().at(-1);
  const syncing = Boolean(pending);
  const needsAttention = loadError || macAccess || summary || data.notificationError;
  const status = needsAttention ? 'Needs attention' : syncing ? 'Refreshing…' : !loadedRange ? 'Opening calendar' : !data.connections.length ? 'No connections' : latest ? 'Updated ' + localTime(latest) : 'Connected';
  $('#sync-status').textContent = status;
  $('#status-dot').className = 'status-dot ' + (needsAttention ? 'warning' : data.connections.length ? 'online' : '');
  $('#refresh').classList.toggle('refreshing', syncing);
  $('#refresh').setAttribute('aria-busy', String(syncing));
  viewport.setAttribute('aria-busy', String(syncing));
  const banners = [];
  const retry = { label: 'Retry refresh', action: refreshCalendars };
  if (notice && notice.text !== data.notificationError) banners.push(banner(notice.text, notice.action, true));
  if (data.uncertain.length) {
    const n = data.uncertain.length;
    banners.push(banner(`${n} unconfirmed ${n === 1 ? 'write needs' : 'writes need'} review.`, { label: 'Review writes', action: panels.uncertainItems }));
  }
  if (loadError) banners.push(banner(loadError, retry));
  if (macAccess || summary || data.notificationError) {
    const primary = macAccess?.message || summary || data.notificationError;
    const row = banner(primary, macAccess || (onlyTickTickPaused && !data.notificationError) ? undefined : retry);
    if (macAccess) {
      row.id = 'mac-calendar-access';
      row.append(...macAccessButtons(macAccess));
    }
    const text = row.querySelector('.notice-text');
    for (const detail of [summary, data.notificationError]) {
      if (detail && detail !== primary) text.append(element('span', 'notice-detail', detail));
    }
    if (accounts.length) {
      const details = button('Sync details', panels.syncDetails, 'text-button');
      details.id = 'sync-details';
      row.append(details);
    }
    banners.push(row);
  }
  $('#notices').replaceChildren(...banners);
}

function beginSchedule(item, change, needsApproval) {
  const key = scheduleKey(item.sourceId, item.id);
  if (pendingSchedules.has(key)) return;
  const edit = { item, change, phase: needsApproval ? 'review' : 'saving' };
  pendingSchedules.set(key, edit);
  renderCalendar();
  return {
    approve() { edit.phase = 'saving'; renderCalendar(); },
    unconfirmed() { edit.phase = 'unconfirmed'; renderCalendar(); },
    finish() { pendingSchedules.delete(key); renderCalendar(); }
  };
}

function projectedItems() {
  if (!pendingSchedules.size && !data.uncertain.length) return data.items;
  const entries = new Map(data.items.map(item => [scheduleKey(item.sourceId, item.id), item]));
  for (const row of data.uncertain) {
    if (!row.targetId) continue;
    const key = scheduleKey(row.sourceId, row.targetId);
    const item = entries.get(key);
    if (item || row.proposedSchedule) {
      entries.set(key, {
        id: row.targetId, sourceId: row.sourceId, title: row.title, ...item, ...row.proposedSchedule, scheduleState: 'unconfirmed'
      });
    }
  }
  for (const [key, edit] of pendingSchedules) {
    const latest = entries.get(key) || edit.item;
    entries.set(key, { ...latest, ...edit.change, scheduleState: edit.phase });
  }
  return [...entries.values()];
}

function renderCalendar() {
  const period = range();
  const calendars = new Map(data.ticktickCalendars.map(calendar => [calendar.id, calendar]));
  const chosen = data.sources.filter(source => source.selected).map(source => {
    const calendar = calendars.get(source.calendarId);
    return { ...source, color: calendar?.color || source.color, context: sourceContext(source, data.connections, calendar?.name) };
  });
  const selected = new Set(chosen.map(source => source.id));
  const hidden = new Set(data.hidden.map(item => scheduleKey(item.sourceId, item.visibilityId ?? item.id)));
  const entries = projectedItems().filter(item => selected.has(item.sourceId) && !hidden.has(scheduleKey(item.sourceId, item.visibilityId ?? item.id)));
  planner.render({ days: period.days, selectedDate, entries, calendars: chosen });
  if (scrollToWorkdayOnRender) {
    planner.scrollToWorkday();
    scrollToWorkdayOnRender = false;
  }
  const empty = $('#empty');
  empty.hidden = data === emptyState || Boolean(chosen.length);
  if (!empty.hidden) {
    const connected = Boolean(data.connections.length);
    const mark = element('div', 'empty-calendar');
    mark.setAttribute('aria-hidden', 'true');
    mark.append(element('i'), element('i'), element('i'), element('i'));
    const title = element('h2', '', connected ? 'Choose your calendars' : 'Connect your first calendar');
    const help = element('p', '', connected ? 'Select the calendars and task lists you want to see here.' : 'Add an account to see its calendars and task lists here.');
    empty.replaceChildren(mark, title, help, button(connected ? 'Choose calendars' : 'Connect calendars', panels.settings, 'primary'));
  }
  const n = chosen.filter(source => source.provider !== 'ticktick').length + data.ticktickCalendars.filter(calendar => calendar.visible).length;
  const shown = entries.filter(item => item.allDay ? item.start < period.end && item.end > period.start :
    localDate(item.start) < period.end && localDate(Math.max(Date.parse(item.start), Date.parse(item.end) - 1)) >= period.start);
  let itemCount = `${shown.length} ${shown.length === 1 ? 'item' : 'items'}`;
  if (!shown.length && data.rangeCovered === false) {
    itemCount = loadError || data.health.some(entry => entry.state !== 'current') ? 'Items unavailable' : 'Checking for items…';
  }
  $('#range-summary').textContent = `${n} ${n === 1 ? 'calendar' : 'calendars'} · ${itemCount}`;
  $('#hidden-items').textContent = data.hidden.length ? 'Hidden items (' + data.hidden.length + ')' : 'Hidden items';
  $('#hidden-items').setAttribute('aria-label', 'Hidden items');
}
function draw() {
  renderHeading();
  renderSources();
  renderCalendar();
  renderStatus();
}

function refreshCalendars() {
  return refresh({ forceRefresh: true, refreshNotifications: true });
}
function refreshMacCalendars() {
  return refresh({ macOnly: true, refreshNotifications: true });
}
function scheduleTickTickRefresh() {
  clearTimeout(tickTickTimer);
  if (pending || document.hidden || !Number.isFinite(data.nextTickTickRefreshAt)) return;
  const remaining = data.nextTickTickRefreshAt - Date.now();
  const delay = Math.min(2_147_000_000, Math.max(loadError ? 60_000 : 250, remaining));
  tickTickTimer = setTimeout(() => {
    if (!pending && !document.hidden) void refresh({ tickTickOnly: true });
  }, delay);
}
function showModel(result, key) {
  if (result.snapshotId < data.snapshotId) return;
  const connections = result.connections.map(connection => ({
    ...connection, providerName: result.connectionOptions.integrations.find(row => row.id === connection.provider)?.name || connection.provider
  }));
  data = { ...emptyState, ...result, sources: labelNativeSources(result.sources), connections };
  for (const row of data.uncertain) {
    const key = scheduleKey(row.sourceId, row.targetId);
    if (pendingSchedules.get(key)?.phase === 'unconfirmed') pendingSchedules.delete(key);
  }
  displayedRange = key;
  renderHeading();
  renderSources();
  renderCalendar();
  panels.sync();
  scheduleTickTickRefresh();
}
function refresh({ force = false, forceRefresh = false, preferencesOnly = false, refreshNotifications = false, readCache = false, navigating = false, macOnly = false, tickTickOnly = false } = {}) {
  const { start, end } = range();
  const key = rangeKey({ start, end });
  const reuseChecks = preferencesOnly && loadedRange === key && !loadError;
  if (!force && pending?.key === key && pending.serial === sequence && (!pending.reuseChecks || reuseChecks) &&
      (!pending.macOnly || macOnly) && (!pending.tickTickOnly || tickTickOnly) &&
      (!refreshNotifications || pending.refreshNotifications) && (!forceRefresh || pending.forceRefresh)) return pending.promise;
  const serial = ++sequence;
  const request = { key, serial, reuseChecks, macOnly, tickTickOnly, forceRefresh, refreshNotifications };
  const current = () => serial === sequence && key === rangeKey(range());
  pending = request;
  renderStatus();
  request.promise = (async () => {
    try {
      if (readCache || displayedRange !== key) {
        const saved = await calendarAction('state', { start, end, cachedOnly: true }).catch(() => undefined);
        if (!current()) return;
        if (saved) showModel(saved, key);
        else draw();
        renderStatus();
      }
      if (navigating) {
        await new Promise(resolve => setTimeout(resolve, 65));
        if (!current()) return;
      }
      const result = await calendarAction('state', { start, end, forceRefresh, ...(reuseChecks && { preferencesOnly: true }),
        ...(refreshNotifications && { refreshNotifications: true }), ...(macOnly && { macOnly: true }), ...(tickTickOnly && { tickTickOnly: true }) });
      if (!current()) return;
      loadedRange = key;
      loadError = '';
      showModel(result, key);
      viewport.dataset.refreshCount = String(++refreshCount);
    } catch (error) {
      if (!current()) return;
      loadError = errorText(error);
      draw();
    } finally {
      if (pending === request) { pending = undefined; renderStatus(); scheduleTickTickRefresh(); }
    }
  })();
  return request.promise;
}
async function showSavedState() {
  for (;;) {
    const { start, end } = range();
    const key = rangeKey({ start, end });
    const result = await calendarAction('state', { start, end, cachedOnly: true });
    if (key !== rangeKey(range())) continue;
    showModel(result, key);
    if (displayedRange === key) return;
  }
}
async function mutate(method, payload) {
  const itemWrite = method === 'save' || method === 'complete' || method === 'remove';
  const { start, end } = range();
  const viewRange = { start, end };
  const key = rangeKey(viewRange);
  let failure, receipt;
  try {
    receipt = await calendarAction(method, itemWrite ? { ...payload, viewRange } : payload);
  } catch (error) { failure = error; }
  if (method === 'hide' || method === 'restore') {
    if (failure) throw failure;
    await showSavedState();
    notice = undefined;
    renderStatus();
    return;
  }
  if (itemWrite || method === 'acknowledge') {
    if (receipt && key === rangeKey(range())) showModel(receipt.state, key);
    else {
      try { await showSavedState(); }
      catch (error) {
        loadError = errorText(error);
        if (receipt && receipt.state.snapshotId > (data.snapshotId ?? 0)) {
          const items = data.items.filter(item => item.sourceId !== payload.sourceId || (item.id !== payload.id && item.id !== receipt.item?.id));
          if (receipt.item) items.push(receipt.item);
          data = { ...data, items, snapshotId: receipt.state.snapshotId };
          renderCalendar();
          panels.sync();
        }
      }
    }
    renderStatus();
    if (failure) throw failure;
    return;
  }
  const preferencesOnly = method === 'setCalendarNotifications' || method === 'setCalendarColor' || method === 'setTickTickSyncInterval' ||
    (!failure && (method === 'configureTickTick' || method === 'setTickTickCalendarVisible' || method === 'renameConnection'));
  while (preferencesOnly && pending && !pending.reuseChecks && pending.serial === sequence) await pending.promise;
  const macConnect = method === 'connect' && (payload.provider === 'mac' || payload.route === 'mac');
  await refresh({ force: true, preferencesOnly, readCache: true, macOnly: macConnect, refreshNotifications: macConnect });
  if (failure) throw failure;
  notice = undefined;
  renderStatus();
}
function showRange(previous) {
  if (rangeKey(range()) === previous) draw();
  else void refresh({ readCache: true, navigating: true });
}
function goTo(date, mode = view, scrollToWorkday = false) {
  panels.closeMenu(false);
  const previous = rangeKey(range());
  view = mode;
  localStorage.setItem('view', view);
  selectedDate = date;
  scrollToWorkdayOnRender = scrollToWorkday;
  month = monthStart(date);
  showRange(previous);
}
function navigate(direction) { goTo(addDays(selectedDate, direction * range().days.length)); }
function goToday() { goTo(localDate(), view, true); }

function setSidebarCollapsed(collapsed) {
  const sidebar = $('#sidebar');
  const toolbar = $('#header-actions');
  if (collapsed) {
    toolbar.append($('#new-item'), $('#manage-calendars'), $('#refresh'));
  } else if (sidebar.hidden) {
    $('.mini-month').before($('#new-item'));
    $('.source-section .section-top').append($('#manage-calendars'));
    $('.sidebar-foot').append($('#refresh'));
  }
  sidebar.hidden = collapsed;
  toolbar.hidden = !collapsed;
  const toggle = $('#toggle-sidebar');
  toggle.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-expanded', String(!collapsed));
}

setSidebarCollapsed(localStorage.getItem('sidebar-collapsed') === 'true');
$('#toggle-sidebar').addEventListener('click', () => {
  const collapsed = !$('#sidebar').hidden;
  setSidebarCollapsed(collapsed);
  localStorage.setItem('sidebar-collapsed', String(collapsed));
});
$('#new-item').addEventListener('click', () => panels.edit());
$('#manage-calendars').addEventListener('click', panels.settings);
$('#hidden-items').addEventListener('click', panels.hiddenItems);
$('#refresh').addEventListener('click', refreshCalendars);
$('#today').addEventListener('click', goToday);
$('#prev').addEventListener('click', () => navigate(-1));
$('#next').addEventListener('click', () => navigate(1));
$('#month-prev').addEventListener('click', () => { month = monthStart(month, -1); renderMini(); });
$('#month-next').addEventListener('click', () => { month = monthStart(month, 1); renderMini(); });
document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => goTo(selectedDate, node.dataset.view)));
function changeCount(commit) {
  const value = $('#day-count').valueAsNumber;
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    if (commit) $('#day-count').value = String(count);
    return;
  }
  if (value === count) return;
  const previous = rangeKey(range());
  count = value;
  localStorage.setItem('next-days', String(count));
  renderDayCount();
  showRange(previous);
}
$('#day-count').addEventListener('input', () => changeCount(false));
$('#day-count').addEventListener('change', () => changeCount(true));
document.addEventListener('keydown', event => {
  if (event.key === 'F5' || ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'r')) {
    event.preventDefault();
    if (!event.repeat) void refreshCalendars();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || $('#dialog').open || !$('#context-menu').hidden || event.target.closest('input, select, textarea, [contenteditable]')) return;
  const key = event.key.toLowerCase();
  if (key === 'n') panels.edit();
  else if (key === 't') goToday();
  else if (key === 'r' && !event.repeat) void refreshCalendars();
  else if (event.target === viewport || event.target === document.body) {
    if (key === 'arrowleft' || key === 'arrowright') { event.preventDefault(); navigate(key === 'arrowleft' ? -1 : 1); }
  }
});

let lastClock = Date.now();
function updateClock(refreshOnWake = true) {
  const current = localDate();
  const currentZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const woke = Date.now() - lastClock > 90000;
  lastClock = Date.now();
  if (current !== today || currentZone !== zone) {
    const follow = selectedDate === today;
    today = current;
    zone = currentZone;
    goTo(follow ? current : selectedDate);
    void refresh({ force: true });
  } else {
    planner.clock();
    if (refreshOnWake && woke && !document.hidden) void refresh();
  }
}
let foreground = document.hasFocus() && !document.hidden;
function resume() {
  if (document.hidden || (foreground && !recheckOnReturn)) return;
  foreground = true;
  if (requestingMacAccess) return;
  updateClock(false);
  if (recheckOnReturn) void recheckOnReturn();
  else void refresh();
}
window.addEventListener('blur', () => { foreground = false; });
window.addEventListener('focus', resume);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { foreground = false; clearTimeout(tickTickTimer); }
  else resume();
});
setInterval(updateClock, 15000);
setInterval(() => {
  if (!document.hidden && data.connections.some(connection => connection.provider !== 'ticktick')) void refresh();
}, 5 * 60000);
renderDayCount();
draw();
void refresh();
