import { button, element, icon, sourceColor } from './dom.js';

export const listCount = count => count + (count === 1 ? ' list' : ' lists');

export function tickTickSections(sources) {
  const sections = [];
  for (const source of sources) {
    const id = source.inbox ? null : source.groupId || null;
    let section = sections.at(-1);
    if (!section || section.id !== id) {
      section = { id, name: id ? source.folder?.name || 'TickTick folder' : '', sources: [] };
      sections.push(section);
    }
    section.sources.push(source);
  }
  return sections;
}

const searchable = text => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

export function createListPicker(sources, change, notes = () => '') {
  const node = element('div', 'list-picker');
  const search = element('input', 'list-search');
  search.type = 'search';
  search.placeholder = 'Search lists or folders';
  search.setAttribute('aria-label', 'Search lists');
  const directory = element('div', 'list-directory');
  directory.setAttribute('role', 'group');
  directory.setAttribute('aria-label', 'TickTick lists');
  const empty = element('p', 'directory-empty help');
  const sections = [];
  const expanded = new Set();
  const collapsedMatches = new Set();
  let query = '';

  function filter() {
    let results = 0;
    for (const section of sections) {
      const folderMatches = query && searchable(section.name).includes(query);
      let matches = 0;
      for (const row of section.rows) {
        row.label.hidden = Boolean(query && !folderMatches && !row.searchName.includes(query));
        if (!row.label.hidden) matches++;
      }
      section.wrapper.hidden = !matches;
      results += matches;
      if (!section.id) continue;
      const open = query ? !collapsedMatches.has(section.id) : expanded.has(section.id);
      section.children.hidden = !open;
      section.disclosure.setAttribute('aria-expanded', String(open));
      section.disclosure.setAttribute('aria-label', (open ? 'Collapse ' : 'Expand ') + section.name);
    }
    empty.hidden = Boolean(results);
    empty.textContent = sources.length ? 'No lists match your search.' : 'No TickTick lists available.';
  }
  for (const { id, name, sources: members } of tickTickSections(sources)) {
    const wrapper = element('div', id ? 'directory-folder' : 'directory-root');
    const section = { id, name, wrapper, rows: [] };
    let children = wrapper;
    if (id) {
      wrapper.dataset.folderId = id;
      const head = element('div', 'folder-heading');
      const disclosure = button('', () => {
        const entries = query ? collapsedMatches : expanded;
        if (entries.has(id)) entries.delete(id);
        else entries.add(id);
        filter();
      }, 'folder-disclosure');
      const count = element('span', 'folder-count');
      disclosure.append(icon('right'), icon('folder'), element('span', 'directory-name', name), count);
      disclosure.title = members[0].folder?.name || id;
      const check = element('input', 'directory-check');
      check.type = 'checkbox';
      check.setAttribute('aria-label', 'Select folder ' + name);
      check.title = 'Select all ' + listCount(members.length) + ' in ' + name;
      check.addEventListener('change', () => change(members, check.checked));
      head.append(disclosure, check);
      children = element('div', 'folder-lists');
      children.id = 'folder-' + crypto.randomUUID();
      disclosure.setAttribute('aria-controls', children.id);
      wrapper.append(head, children);
      Object.assign(section, { children, disclosure, count, check });
    }
    for (const source of members) {
      const label = element('label', 'directory-list');
      label.dataset.sourceId = source.id;
      label.dataset.archived = String(Boolean(source.archived));
      const mark = icon(source.inbox ? 'inbox' : 'list');
      mark.style.color = sourceColor(source);
      const text = element('span', 'directory-name', source.name);
      text.title = source.name;
      const check = element('input', 'directory-check');
      check.type = 'checkbox';
      check.dataset.sourceId = source.id;
      check.setAttribute('aria-label', source.name);
      check.addEventListener('change', () => change([source], check.checked));
      label.append(mark, text);
      const note = [source.archived ? 'Archived' : '', notes(source)].filter(Boolean).join(' · ');
      if (note) {
        const detail = element('span', 'directory-note', note);
        detail.title = note;
        label.append(detail);
        check.setAttribute('aria-description', note);
      }
      label.append(check);
      children.append(label);
      section.rows.push({ id: source.id, label, check, searchName: searchable(source.name) });
    }
    sections.push(section);
    directory.append(wrapper);
  }
  directory.append(empty);
  node.append(search, directory);
  search.addEventListener('input', () => {
    query = searchable(search.value.trim());
    collapsedMatches.clear();
    filter();
    directory.scrollTop = 0;
  });
  filter();
  return {
    node,
    update(selected) {
      for (const section of sections) {
        let count = 0;
        for (const row of section.rows) {
          row.check.checked = selected.has(row.id);
          if (row.check.checked) count++;
        }
        if (!section.id) continue;
        const total = section.rows.length;
        section.check.checked = count === total;
        section.check.indeterminate = count > 0 && count < total;
        section.count.textContent = section.check.indeterminate ? count + ' / ' + total : listCount(total);
      }
    }
  };
}
