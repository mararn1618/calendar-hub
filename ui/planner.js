import { MINUTE, SLOT, addDays, createAxis, differenceInDays, formatDate, localDate, localMidnight, localTime, timedLayout, zoneOffset } from './dates.js';
import { button, editable, element, sourceColor } from './dom.js';

const PIXELS_PER_MINUTE = 1.1;
const iso = instant => new Date(instant).toISOString();
const quarter = minutes => Math.round(minutes / SLOT) * SLOT;

export function createPlanner(viewport, actions) {
  let dates = [];
  let axis;
  let sources = new Map();
  let items = new Map();
  let columns = new Map();
  let gesture;
  let frame = 0;
  let skipClick = false;
  let dateScroll = 0;
  let lastWheel = 0;
  let wheelLocked = false;
  let wheelTimer;
  let initialScroll = true;
  let snapshot;
  let timeZone;
  const key = (sourceId, itemId) => JSON.stringify([sourceId, itemId]);

  function render({ days, selectedDate, entries, calendars }) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const signature = JSON.stringify([days, selectedDate, entries, calendars.map(s => [s.id, s.name, s.context, s.provider, s.color, s.writable, s.readOnly]), zone, localDate()]);
    if (signature === snapshot) {
      clock();
      return;
    }
    cancel();
    snapshot = signature;
    const rangeChanged = days.join() !== dates.join();
    const oldTop = viewport.scrollTop;
    const focusedItem = document.activeElement?.closest('.calendar-item');
    if (rangeChanged || !axis || zone !== timeZone) axis = createAxis(days);
    timeZone = zone;
    dates = days;
    sources = new Map(calendars.map(source => [source.id, source]));
    items = new Map(entries.map(item => [key(item.sourceId, item.id), item]));
    columns = new Map();

    const sheet = element('div', 'calendar-sheet');
    sheet.style.setProperty('--day-count', String(days.length));
    sheet.style.setProperty('--sheet-min', (60 + (days.length === 1 ? 0 : days.length * 114)) + 'px');
    const header = element('div', 'timeline-header');
    const labels = element('div', 'date-row sheet-row');
    const allDay = element('div', 'all-day-row sheet-row');
    const times = element('div', 'time-row sheet-row');
    const ruler = element('div', 'time-ruler gutter');
    const currentDay = localDate();
    labels.append(element('div', 'gutter zone-offset', zoneOffset(localMidnight(selectedDate))));
    allDay.append(element('div', 'gutter all-day-label', 'All day'));
    times.style.height = axis.minutes * PIXELS_PER_MINUTE + 'px';
    for (const tick of axis.ticks) {
      const tickLabel = element('span', 'hour-label', tick.time);
      tickLabel.dataset.time = tick.time;
      tickLabel.style.top = tick.minute * PIXELS_PER_MINUTE + 'px';
      if (tick.offset) tickLabel.append(element('small', '', tick.offset));
      ruler.append(tickLabel);
    }
    times.append(ruler);
    for (const day of days) {
      const date = button('', () => actions.selectDay(day), 'day-header');
      date.dataset.date = day;
      date.setAttribute('aria-label', formatDate(day, { dateStyle: 'full' }));
      date.title = 'Open day';
      if (day === currentDay) date.classList.add('today');
      if (day === selectedDate) date.classList.add('selected');
      const weekDay = formatDate(day, { weekday: 'short' });
      date.append(element('span', 'column-weekday', weekDay), element('span', 'column-number', String(Number(day.slice(-2)))));
      labels.append(date);
      const strip = element('div', 'all-day-cell');
      strip.dataset.date = day;
      strip.setAttribute('aria-label', 'All day on ' + day);
      entries.filter(item => item.allDay && item.start <= day && day < item.end)
        .sort((a, b) => a.title.localeCompare(b.title))
        .forEach(item => strip.append(itemButton(item, day)));
      allDay.append(strip);

      const column = element('div', 'day-column');
      column.dataset.date = day;
      column.setAttribute('aria-label', 'Hours on ' + day);
      if (day === currentDay) column.classList.add('today');
      if (weekDay === 'Sat' || weekDay === 'Sun') column.classList.add('weekend');
      for (const tick of axis.ticks) {
        const line = element('div', 'hour-line');
        line.dataset.time = tick.time;
        line.style.top = tick.minute * PIXELS_PER_MINUTE + 'px';
        column.append(line);
      }
      let missing;
      axis.slots.forEach((_, index) => {
        if (axis.days.get(day).byIndex.has(index)) {
          missing = undefined;
          return;
        }
        if (!missing) {
          missing = element('div', 'missing-hour');
          missing.title = 'This local time does not occur on this date';
          missing.style.top = index * SLOT * PIXELS_PER_MINUTE + 'px';
          column.append(missing);
        }
        missing.style.height = ((index + 1) * SLOT * PIXELS_PER_MINUTE - parseFloat(missing.style.top)) + 'px';
      });
      for (const segment of timedLayout(entries, day, axis)) {
        const block = itemButton(segment.item, day, segment);
        block.style.top = segment.from * PIXELS_PER_MINUTE + 'px';
        block.style.height = Math.max(14, (Math.min(axis.minutes, segment.to) - segment.from) * PIXELS_PER_MINUTE - 1) + 'px';
        block.style.left = `calc(${segment.column * 100 / segment.columns}% + 3px)`;
        block.style.width = `calc(${100 / segment.columns}% - 5px)`;
        column.append(block);
      }
      columns.set(day, column);
      times.append(column);
    }
    header.append(labels, allDay);
    sheet.append(header, times);
    viewport.replaceChildren(sheet);
    viewport.scrollTop = oldTop;
    if (rangeChanged) viewport.scrollLeft = 0;
    if (initialScroll) {
      scrollToWorkday();
      initialScroll = false;
    }
    if (focusedItem && !document.querySelector('dialog[open]')) {
      const replacement = [...viewport.querySelectorAll('.calendar-item')].find(node =>
        node.dataset.itemId === focusedItem.dataset.itemId && node.dataset.sourceId === focusedItem.dataset.sourceId && node.dataset.date === focusedItem.dataset.date);
      (replacement || viewport).focus({ preventScroll: true });
    }
    clock();
  }

  function itemButton(item, day, segment) {
    const source = sources.get(item.sourceId);
    const block = element('button', segment ? 'calendar-item timed-item' : 'calendar-item all-day-item');
    block.type = 'button';
    block.dataset.itemId = item.id;
    block.dataset.sourceId = item.sourceId;
    block.dataset.date = day;
    block.dataset.editable = String(editable(item, source));
    block.style.setProperty('--source-color', sourceColor(source));
    const time = item.allDay ? 'All day' : timeLabel(item);
    block.setAttribute('aria-label', item.title);
    block.setAttribute('aria-description', [time, source.context || source.name, item.completed ? 'Completed' : '', item.recurring ? 'Recurring' : ''].filter(Boolean).join(', '));
    block.title = [item.title, time, source.context || source.name].join(' · ');
    if (item.completed) block.classList.add('completed');
    const title = element('span', 'item-title');
    if (source.provider === 'ticktick') title.append(element('span', 'task-box', item.completed ? '✓' : ''));
    title.append(document.createTextNode(item.title));
    block.append(title);
    if (segment) {
      const height = (segment.to - segment.from) * PIXELS_PER_MINUTE;
      if (height < 38) block.classList.add('short');
      if (height >= 52) block.classList.add('roomy');
      if (height >= 38) block.append(element('span', 'item-time', time));
      if (editable(item, source)) {
        for (const edge of ['start', 'end']) {
          if ((edge === 'start' && !segment.startsHere) || (edge === 'end' && !segment.endsHere)) continue;
          const handle = element('span', 'resize-handle');
          handle.dataset.edge = edge;
          handle.title = 'Resize ' + edge;
          block.append(handle);
        }
      }
    }
    return block;
  }

  function timeLabel(item) {
    const start = localTime(item.start);
    const end = localTime(item.end);
    if (Date.parse(item.start) === Date.parse(item.end)) return start;
    if (localDate(item.start) !== localDate(item.end)) return `${start} – ${formatDate(localDate(item.end), { day: 'numeric', month: 'short' })} ${end}`;
    if (zoneOffset(item.start) !== zoneOffset(item.end)) return `${start} ${zoneOffset(item.start)} – ${end} ${zoneOffset(item.end)}`;
    return start + ' – ' + end;
  }

  function clock() {
    viewport.querySelector('.now-line')?.remove();
    const now = Date.now();
    const day = localDate(now);
    const column = columns.get(day);
    if (!column) return;
    const line = element('div', 'now-line');
    line.title = 'Current time ' + localTime(now);
    line.setAttribute('aria-label', line.title);
    line.style.top = axis.position(day, now) * PIXELS_PER_MINUTE + 'px';
    line.append(element('span', 'now-label', localTime(now)));
    column.append(line);
  }

  function scrollToWorkday() {
    if (!axis || !dates.length) return;
    const day = dates.includes(localDate()) ? localDate() : dates[0];
    const morning = new Date(day + 'T07:30:00').getTime();
    viewport.scrollTop = axis.position(day, morning) * PIXELS_PER_MINUTE;
  }

  function itemFrom(target) {
    const block = target.closest?.('.calendar-item');
    return block && items.get(key(block.dataset.sourceId, block.dataset.itemId));
  }

  viewport.addEventListener('click', event => {
    if (skipClick) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const item = itemFrom(event.target);
    if (item) actions.edit(item);
  });
  viewport.addEventListener('dblclick', event => {
    if (event.target.closest('button')) return;
    const cell = event.target.closest('.day-column, .all-day-cell');
    if (!cell) return;
    const day = cell.dataset.date;
    if (cell.classList.contains('all-day-cell')) return actions.create({ day, allDay: true });
    const minute = quarter((event.clientY - cell.getBoundingClientRect().top) / PIXELS_PER_MINUTE);
    const start = axis.instantAt(day, minute);
    if (start !== null) actions.create({ day, start });
  });
  viewport.addEventListener('contextmenu', event => {
    const item = itemFrom(event.target);
    if (!item) return;
    event.preventDefault();
    cancel();
    actions.menu(item, event.clientX, event.clientY, event.target.closest('.calendar-item'));
  });
  viewport.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    const item = itemFrom(event.target);
    if (!item) return;
    event.preventDefault();
    const box = event.target.getBoundingClientRect();
    actions.menu(item, box.left, box.bottom, event.target);
  });

  viewport.addEventListener('wheel', event => {
    const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
    if (event.ctrlKey || !dx || (!event.shiftKey && Math.abs(dx) < Math.abs(event.deltaY) * 1.2)) return;
    const delta = dx * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1);
    const overflow = viewport.scrollWidth - viewport.clientWidth;
    event.preventDefault();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { dateScroll = 0; wheelLocked = false; }, 160);
    if (wheelLocked) return;
    if ((delta > 0 && viewport.scrollLeft < overflow - 2) || (delta < 0 && viewport.scrollLeft > 2)) {
      viewport.scrollLeft += delta;
      dateScroll = 0;
      return;
    }
    if (performance.now() - lastWheel > 200 || Math.sign(delta) !== Math.sign(dateScroll)) dateScroll = 0;
    lastWheel = performance.now();
    dateScroll += delta;
    if (Math.abs(dateScroll) >= 70) {
      wheelLocked = true;
      actions.navigate(Math.sign(dateScroll));
      dateScroll = 0;
    }
  }, { passive: false });

  viewport.addEventListener('pointerdown', event => {
    if (gesture && event.pointerId !== gesture.pointerId) { cancel(); return; }
    if (event.button !== 0 || !event.isPrimary) return;
    const block = event.target.closest('.calendar-item');
    const item = itemFrom(event.target);
    if (!item || !editable(item, sources.get(item.sourceId))) return;
    const date = block.dataset.date;
    const edge = event.target.closest('[data-edge]')?.dataset.edge;
    let offset = 0;
    if (!item.allDay && !edge) {
      const minute = (event.clientY - columns.get(date).getBoundingClientRect().top) / PIXELS_PER_MINUTE;
      const grabbed = axis.instantAt(date, Math.max(0, Math.min(axis.minutes, minute)));
      offset = Math.max(0, Math.min(Date.parse(item.end) - Date.parse(item.start), (grabbed ?? Date.parse(item.start)) - Date.parse(item.start)));
    }
    gesture = { item, block, date, edge, offset, pointerId: event.pointerId, originX: event.clientX, originY: event.clientY, x: event.clientX, y: event.clientY };
  });

  function proposal(drag) {
    const cell = document.elementFromPoint(drag.x, drag.y)?.closest('.day-column, .all-day-cell');
    if (!cell || !viewport.contains(cell)) return;
    const day = cell.dataset.date;
    const { item, edge } = drag;
    if (cell.classList.contains('all-day-cell')) {
      if (edge) return;
      const span = item.allDay ? differenceInDays(item.start, item.end) : 1 + differenceInDays(localDate(item.start), localDate(Math.max(Date.parse(item.start), Date.parse(item.end) - 1)));
      const offsetDays = item.allDay ? differenceInDays(item.start, drag.date) : 0;
      const start = addDays(day, -offsetDays);
      return { start, end: addDays(start, Math.max(1, span)), allDay: true, cell };
    }
    const minute = (drag.y - cell.getBoundingClientRect().top) / PIXELS_PER_MINUTE;
    const instant = axis.instantAt(day, edge || item.allDay ? quarter(minute) : minute, edge === 'end');
    if (instant === null) return;
    let start = Date.parse(item.start);
    let end = Date.parse(item.end);
    if (edge === 'start') start = Math.min(instant, end - SLOT * MINUTE);
    else if (edge === 'end') end = Math.max(instant, start + SLOT * MINUTE);
    else {
      const duration = item.allDay ? 30 * MINUTE : end - start;
      const proposed = instant - drag.offset;
      const midnight = localMidnight(localDate(proposed));
      start = midnight + quarter((proposed - midnight) / MINUTE) * MINUTE;
      end = start + duration;
    }
    return { start: iso(start), end: iso(end), allDay: false, cell };
  }

  function preview(drag) {
    viewport.querySelectorAll('.drag-preview').forEach(node => node.remove());
    const next = proposal(drag);
    if (!next) return;
    if (next.allDay) {
      next.cell.append(element('span', 'drag-preview all-day-preview', drag.item.title));
      return;
    }
    for (const [date, column] of columns) {
      const segments = timedLayout([{ ...drag.item, ...next }], date, axis);
      if (!segments.length) continue;
      const segment = segments[0];
      const ghost = element('div', 'drag-preview timed-preview');
      ghost.style.top = segment.from * PIXELS_PER_MINUTE + 'px';
      ghost.style.height = Math.max(16, (segment.to - segment.from) * PIXELS_PER_MINUTE) + 'px';
      ghost.textContent = timeLabel(next) + ' · ' + drag.item.title;
      column.append(ghost);
    }
  }

  function autoScroll() {
    const drag = gesture;
    if (!drag?.active) return;
    const bounds = viewport.getBoundingClientRect();
    const header = viewport.querySelector('.timeline-header').getBoundingClientRect();
    if (drag.x >= bounds.left && drag.x <= bounds.right && drag.y > header.bottom && drag.y <= bounds.bottom) {
      const dy = drag.y < header.bottom + 26 ? -7 : drag.y > bounds.bottom - 30 ? 7 : 0;
      const dx = drag.x < bounds.left + 76 ? -7 : drag.x > bounds.right - 32 ? 7 : 0;
      const edge = dx || dy ? [dx, dy].join('/') : '';
      if (edge !== drag.scrollEdge) {
        drag.scrollEdge = edge;
        drag.edgeSince = performance.now();
      } else if (edge && performance.now() - drag.edgeSince >= 220) {
        const oldTop = viewport.scrollTop, oldLeft = viewport.scrollLeft;
        viewport.scrollBy(dx, dy);
        if (oldTop !== viewport.scrollTop || oldLeft !== viewport.scrollLeft) preview(drag);
      }
    } else drag.scrollEdge = '';
    frame = requestAnimationFrame(autoScroll);
  }
  window.addEventListener('pointermove', event => {
    const drag = gesture;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active) {
      if (Math.hypot(drag.x - drag.originX, drag.y - drag.originY) < 5) return;
      drag.active = true;
      drag.block.setPointerCapture(event.pointerId);
      drag.block.classList.add('drag-origin');
      document.body.classList.add('dragging');
      frame = requestAnimationFrame(autoScroll);
    }
    event.preventDefault();
    preview(drag);
  });
  window.addEventListener('pointerup', event => {
    const drag = gesture;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    const next = drag.active && proposal(drag);
    cancel();
    if (!next) return;
    const { cell, ...change } = next;
    const sameTime = drag.item.allDay === change.allDay && (change.allDay
      ? drag.item.start === change.start && drag.item.end === change.end
      : Date.parse(drag.item.start) === Date.parse(change.start) && Date.parse(drag.item.end) === Date.parse(change.end));
    if (!sameTime) actions.reschedule(drag.item, change);
  });

  function cancel() {
    if (!gesture) return;
    const drag = gesture;
    gesture = undefined;
    if (!drag.active) return;
    skipClick = true;
    setTimeout(() => { skipClick = false; }, 0);
    cancelAnimationFrame(frame);
    if (drag.block.hasPointerCapture(drag.pointerId)) drag.block.releasePointerCapture(drag.pointerId);
    document.body.classList.remove('dragging');
    drag.block.classList.remove('drag-origin');
    viewport.querySelectorAll('.drag-preview').forEach(node => node.remove());
  }
  window.addEventListener('pointercancel', cancel);
  viewport.addEventListener('lostpointercapture', cancel);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
  return { render, clock, scrollToWorkday };
}
