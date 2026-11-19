import { addDays, dateRangeLabel, formatDate, localDate, localTime, monday, monthStart, weekNumber } from './dates.js';
import { $, button, element, errorText, healthFor, icon, iconButton, providers, sourceCheckbox, tickTickCalendarCheckbox } from './dom.js';
import { createPanels } from './panels.js';
import { createPlanner } from './planner.js';

const emptyState = { connections: [], sources: [], ticktickCalendars: [], items: [], hidden: [], health: [], uncertain: [] };
let data = emptyState;
let selectedDate = localDate();
let month = monthStart(selectedDate);
let today = selectedDate;
let zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let view = ['day', 'week', 'next'].includes(localStorage.getItem('view')) ? localStorage.getItem('view') : 'day';
let count = Math.max(1, Math.min(31, Number(localStorage.getItem('next-days')) || 3));
let loadedRange = '';
let loadError = '';
let notice;
let sequence = 0;
let pending;
let refreshCount = 0;
let refreshTimer;
let toastTimer;
const rangeCache = new Map();
const viewport = $('#timeline');
viewport.dataset.refreshCount = '0';

function range() {
  const start = view === 'week' ? monday(selectedDate) : selectedDate;
  const size = view === 'day' ? 1 : view === 'week' ? 7 : count;
  return { start, end: addDays(start, size), days: Array.from({ length: size }, (_, index) => addDays(start, index)) };
}
const rangeKey = period => period.start + '/' + period.end;

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
  state: () => data, selectedDate: () => selectedDate, mutate, report, toast, refresh: () => refresh(true)
});
const planner = createPlanner(viewport, {
  selectDay: day => goTo(day, 'day'), navigate, edit: panels.edit, create: defaults => panels.edit(undefined, defaults),
  menu: panels.menu, reschedule: panels.reschedule
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
function renderHeading() {
  const { days, start } = range();
  $('#range-title').textContent = dateRangeLabel(start, days.at(-1));
  $('#range-context').textContent = `Week ${weekNumber(selectedDate)} · ${selectedDate.slice(0, 4)}`;
  $('#count-control').hidden = view !== 'next';
  $('#day-count').value = String(count);
  for (const node of document.querySelectorAll('[data-view]')) node.setAttribute('aria-pressed', String(node.dataset.view === view));
  $('#zone-name').textContent = zone.replaceAll('_', ' ').replaceAll('/', ' / ');
  renderMini();
}
function renderSources() {
  const list = $('#source-list');
  const groups = [];
  for (const connection of data.connections) {
    const group = element('div', 'sidebar-group');
    const heading = element('h3', '', connection.name || providers[connection.provider]);
    heading.title = heading.textContent;
    if (connection.provider === 'ticktick') {
      const calendars = data.ticktickCalendars.filter(calendar => calendar.connectionId === connection.id);
      const configure = iconButton('Edit TickTick lists', 'settings', () => panels.tickTickLists(connection.id));
      configure.id = 'edit-ticktick-' + connection.id;
      configure.dataset.connectionId = connection.id;
      configure.title = 'Edit lists for ' + heading.textContent;
      const row = element('div', 'sidebar-calendar-heading');
      group.append(row);
      const toggles = calendars.map(calendar => tickTickCalendarCheckbox(calendar, async visible => {
        try { await mutate('setTickTickCalendarVisible', { connectionId: connection.id, calendarId: calendar.id, visible }); }
        catch (error) { report(errorText(error)); renderSources(); }
      }, data.health));
      if (connection.ticktick.mode === 'account' && toggles.length === 1) row.append(toggles[0], configure);
      else {
        row.append(heading, configure);
        group.append(...toggles);
      }
      groups.push(group);
      continue;
    }
    group.append(heading);
    for (const source of data.sources.filter(source => source.connectionId === connection.id)) {
      group.append(sourceCheckbox(source, async selected => {
        try { await mutate('setSource', { sourceId: source.id, selected }); }
        catch (error) { report(errorText(error)); renderSources(); }
      }, healthFor(source, data.health)));
    }
    groups.push(group);
  }
  if (!groups.length) {
    const add = button('', panels.settings, 'add-calendar');
    add.append(icon('plus'), document.createTextNode('Add a connection'));
    groups.push(add);
  }
  list.replaceChildren(...groups);
}

function banner(text, action, dismiss = false, alert = true) {
  const row = element('div', 'notice');
  row.setAttribute('role', alert ? 'alert' : 'status');
  row.append(element('span', 'notice-symbol', '!'), element('span', 'notice-text', text));
  if (action) row.append(button(action.label, action.action, 'text-button'));
  if (dismiss) row.append(iconButton('Dismiss message', 'close', () => { notice = undefined; renderStatus(); }));
  return row;
}
function renderStatus() {
  const failures = data.health.filter(entry => entry.state !== 'current');
  const latest = data.health.map(h => h.checkedAt).filter(Boolean).sort().at(-1);
  const syncing = Boolean(pending);
  const status = loadError || failures.length ? 'Needs attention' : syncing ? 'Refreshing…' : !loadedRange ? 'Opening calendar' : !data.connections.length ? 'No connections' : latest ? 'Updated ' + localTime(latest) : 'Connected';
  $('#sync-status').textContent = status;
  $('#status-dot').className = 'status-dot ' + (loadError || failures.length ? 'warning' : data.connections.length ? 'online' : '');
  $('#refresh').classList.toggle('refreshing', syncing);
  $('#refresh').setAttribute('aria-busy', String(syncing));
  viewport.setAttribute('aria-busy', String(syncing));
  const banners = [];
  const retry = { label: 'Retry refresh', action: () => refresh(true) };
  if (loadError) banners.push(banner(loadError, retry));
  if (failures.length) {
    const descriptions = failures.map(entry => {
      const name = data.sources.find(source => source.id === entry.sourceId)?.name || data.connections.find(connection => connection.id === entry.connectionId)?.name || 'Calendar';
      const stale = entry.state === 'stale' ? ` is stale. Last checked ${localTime(entry.checkedAt)}.` : ' is unavailable.';
      return name + stale + (entry.message ? ' ' + entry.message : '');
    });
    banners.push(banner([...new Set(descriptions)].join(' '), retry));
  }
  if (data.uncertain.length) {
    const n = data.uncertain.length;
    banners.push(banner(`${n} unconfirmed ${n === 1 ? 'write needs' : 'writes need'} review.`, { label: 'Review writes', action: panels.uncertainItems }));
  }
  if (notice) banners.push(banner(notice.text, notice.action, true));
  $('#notices').replaceChildren(...banners);
}

function renderCalendar() {
  const period = range();
  const calendars = new Map(data.ticktickCalendars.map(calendar => [calendar.id, calendar]));
  const chosen = data.sources.filter(source => source.selected).map(source => {
    const calendar = calendars.get(source.calendarId);
    if (!calendar) return source;
    const context = [...new Set([calendar.name, source.folder?.name, source.name].filter(Boolean))].join(' · ');
    return { ...source, color: calendar.color, context };
  });
  const selected = new Set(chosen.map(source => source.id));
  const hidden = new Set(data.hidden.map(item => JSON.stringify([item.sourceId, item.id])));
  const entries = data.items.filter(item => selected.has(item.sourceId) && !hidden.has(JSON.stringify([item.sourceId, item.id])));
  planner.render({ days: period.days, selectedDate, entries, calendars: chosen });
  const empty = $('#empty');
  empty.hidden = !loadedRange || Boolean(chosen.length);
  if (!empty.hidden) {
    const connected = Boolean(data.connections.length);
    const mark = element('div', 'empty-calendar');
    mark.setAttribute('aria-hidden', 'true');
    mark.append(element('i'), element('i'), element('i'), element('i'));
    const title = element('h2', '', connected ? 'Choose your calendars' : 'Connect your first calendar');
    const help = element('p', '', connected ? 'Select the calendars and task lists you want to see here.' : 'Plan with your TickTick tasks, Google events and Mac calendars in one place.');
    empty.replaceChildren(mark, title, help, button(connected ? 'Choose calendars' : 'Connect calendars', panels.settings, 'primary'));
  }
  const n = chosen.filter(source => source.provider !== 'ticktick').length + data.ticktickCalendars.filter(calendar => calendar.visible).length;
  const shown = entries.filter(item => item.allDay ? item.start < period.end && item.end > period.start :
    localDate(item.start) < period.end && localDate(Math.max(Date.parse(item.start), Date.parse(item.end) - 1)) >= period.start);
  $('#range-summary').textContent = `${n} ${n === 1 ? 'calendar' : 'calendars'} · ${shown.length} ${shown.length === 1 ? 'item' : 'items'}`;
  $('#hidden-items').textContent = data.hidden.length ? 'Hidden items (' + data.hidden.length + ')' : 'Hidden items';
  $('#hidden-items').setAttribute('aria-label', 'Hidden items');
}
function draw() {
  renderHeading();
  renderSources();
  renderCalendar();
  renderStatus();
}

function refresh(force = false, preferencesOnly = false) {
  clearTimeout(refreshTimer);
  const { start, end } = range();
  const key = rangeKey({ start, end });
  const reuseChecks = preferencesOnly && loadedRange === key && !loadError;
  if (!force && pending?.key === key && pending.serial === sequence && (!pending.reuseChecks || reuseChecks)) return pending.promise;
  const serial = ++sequence;
  const request = { key, serial, reuseChecks };
  pending = request;
  renderStatus();
  request.promise = (async () => {
    try {
      if (!window.calendar?.state) throw new Error('Open the Calendar Central Mac app to load your calendars.');
      const result = await window.calendar.state({ start, end, ...(reuseChecks && { preferencesOnly: true }) });
      if (serial !== sequence || key !== rangeKey(range())) return;
      data = { ...emptyState, ...result };
      loadedRange = key;
      loadError = '';
      rangeCache.delete(key);
      rangeCache.set(key, data.items);
      if (rangeCache.size > 12) rangeCache.delete(rangeCache.keys().next().value);
      renderSources();
      renderCalendar();
      panels.sync();
      viewport.dataset.refreshCount = String(++refreshCount);
    } catch (error) {
      if (serial !== sequence || key !== rangeKey(range())) return;
      loadError = errorText(error);
    } finally {
      if (pending === request) { pending = undefined; renderStatus(); }
    }
  })();
  return request.promise;
}
async function mutate(method, payload) {
  let failure;
  try {
    if (!window.calendar?.[method]) throw new Error('Open the Calendar Central Mac app to change a calendar.');
    await window.calendar[method](payload);
  } catch (error) { failure = error; }
  const preferencesOnly = !failure && (method === 'configureTickTick' || method === 'setTickTickCalendarVisible');
  while (preferencesOnly && pending && !pending.reuseChecks && pending.serial === sequence) await pending.promise;
  rangeCache.clear();
  await refresh(true, preferencesOnly);
  if (failure) throw failure;
  notice = undefined;
  renderStatus();
}
function showRange(previous) {
  const key = rangeKey(range());
  if (key !== previous) {
    sequence++;
    data = { ...data, items: rangeCache.get(key) || [] };
  }
  draw();
  if (key !== previous) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(), 65);
  }
}
function goTo(date, mode = view) {
  panels.closeMenu(false);
  const previous = rangeKey(range());
  view = mode;
  localStorage.setItem('view', view);
  selectedDate = date;
  month = monthStart(date);
  showRange(previous);
}
function navigate(direction) { goTo(addDays(selectedDate, direction * range().days.length)); }
function goToday() { goTo(localDate()); planner.scrollToWorkday(); }

$('#new-item').addEventListener('click', () => panels.edit());
$('#manage-calendars').addEventListener('click', panels.settings);
$('#hidden-items').addEventListener('click', panels.hiddenItems);
$('#refresh').addEventListener('click', () => refresh(true));
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
  showRange(previous);
}
$('#day-count').addEventListener('input', () => changeCount(false));
$('#day-count').addEventListener('change', () => changeCount(true));
document.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey || $('#dialog').open || !$('#context-menu').hidden || event.target.closest('input, select, textarea, [contenteditable]')) return;
  const key = event.key.toLowerCase();
  if (key === 'n') panels.edit();
  else if (key === 't') goToday();
  else if (event.target === viewport || event.target === document.body) {
    if (key === 'arrowleft' || key === 'arrowright') { event.preventDefault(); navigate(key === 'arrowleft' ? -1 : 1); }
  }
});

let lastClock = Date.now();
function updateClock() {
  const current = localDate();
  const currentZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const woke = Date.now() - lastClock > 90000;
  lastClock = Date.now();
  if (current !== today || currentZone !== zone) {
    const follow = selectedDate === today;
    today = current;
    zone = currentZone;
    goTo(follow ? current : selectedDate);
    void refresh(true);
  } else {
    planner.clock();
    if (woke && !document.hidden) void refresh();
  }
}
function resume() {
  if (document.hidden) return;
  updateClock();
  void refresh();
}
window.addEventListener('focus', resume);
document.addEventListener('visibilitychange', resume);
setInterval(updateClock, 15000);
setInterval(() => { if (!document.hidden) void refresh(); }, 5 * 60000);
draw();
void refresh();
