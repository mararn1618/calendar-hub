import { button, element, icon } from './dom.js';
import { createListPicker, listCount } from './ticktick-lists.js';

function toggleLists(selection, sources, checked) {
  for (const source of sources) {
    if (checked) selection.add(source.id);
    else selection.delete(source.id);
  }
}

export function createTickTickEditor({ connection, sources, heading, body, footer, cancel, save, clearError }) {
  const initial = connection.ticktick;
  let draft = { mode: initial.mode, includedSourceIds: initial.includedSourceIds, groups: initial.groups };
  const history = [];
  const active = new Set(sources.filter(source => !source.archived).map(source => source.id));
  const included = () => draft.includedSourceIds === null ? active : new Set(draft.includedSourceIds);
  const root = element('div', 'ticktick-editor');
  let groupEditor;
  let groupTrigger;
  const editButtons = new Map();

  function change(patch) {
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(draft[key]) === JSON.stringify(value))) return;
    history.push(draft);
    draft = { ...draft, ...patch };
    clearError();
    updateRoot();
  }

  const modes = element('div', 'segmented calendar-modes');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', 'Sidebar calendars');
  const modeButtons = new Map();
  for (const [value, label] of [['account', 'One calendar'], ['folders', 'By folder'], ['custom', 'Custom calendars']]) {
    const control = button(label, () => change({ mode: value }));
    modeButtons.set(value, control);
    modes.append(control);
  }
  const modeHeading = connection.name === 'TickTick' ? 'Show in sidebar' : 'Show ' + connection.name + ' in sidebar';
  const modeHint = element('p', 'help');
  const modeSection = element('section', 'calendar-mode-section');
  modeSection.append(element('h3', 'field-label', modeHeading), modes, modeHint);

  const custom = element('section', 'custom-calendars');
  const customHeader = element('div', 'section-top');
  const add = button('Add calendar', () => editGroup(), 'text-button');
  customHeader.append(element('h3', 'field-label', 'Your calendars'), add);
  const roster = element('div', 'custom-calendar-list');
  custom.append(customHeader, roster);

  const mainLists = element('section', 'included-lists');
  const headingRow = element('div', 'section-top');
  const count = element('span', 'list-count');
  headingRow.append(element('h3', 'field-label', 'Included lists'), count);
  const bulk = element('div', 'list-bulk-actions');
  const auto = element('label', 'check-field');
  const master = element('input');
  master.type = 'checkbox';
  master.addEventListener('change', () => change({ includedSourceIds: master.checked ? null : [] }));
  auto.append(master, document.createTextNode('All active and future lists'));
  const clear = button('Clear selection', () => change({ includedSourceIds: [] }), 'text-button');
  bulk.append(auto, clear);
  const picker = createListPicker(sources, (members, checked) => {
    const next = new Set(included());
    toggleLists(next, members, checked);
    change({ includedSourceIds: [...next] });
  });
  mainLists.append(headingRow, bulk, picker.node);
  root.append(modeSection, custom, mainLists);
  body.append(root);

  const undo = button('Undo', () => {
    if (!history.length) return;
    draft = history.pop();
    clearError();
    updateRoot();
  }, 'text-button left-action');
  undo.title = 'Undo the last change';
  const cancelRoot = button('Cancel', cancel);
  const saveRoot = button('Save', () => {
    const patch = {};
    for (const key of ['mode', 'includedSourceIds', 'groups']) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(initial[key])) patch[key] = draft[key];
    }
    if (Object.keys(patch).length) save(patch);
    else cancel();
  }, 'primary');
  footer.append(undo, cancelRoot, saveRoot);
  let displayedGroups;

  function updateRoot() {
    for (const [value, control] of modeButtons) control.setAttribute('aria-pressed', String(draft.mode === value));
    modeHint.textContent = {
      account: 'Included lists share one calendar.',
      folders: 'Each folder gets a calendar. Inbox and standalone lists share Unfiled lists.',
      custom: 'Unassigned lists stay in ' + connection.name + '.'
    }[draft.mode];
    custom.hidden = draft.mode !== 'custom';
    if (displayedGroups !== draft.groups) {
      displayedGroups = draft.groups;
      editButtons.clear();
      roster.replaceChildren();
      for (const group of draft.groups) {
        const edit = button('', () => editGroup(group), 'custom-calendar-row');
        edit.setAttribute('aria-label', 'Edit ' + group.name);
        edit.append(element('span', 'directory-name', group.name), element('span', 'list-count', listCount(group.sourceIds.length)), icon('right'));
        editButtons.set(group.id, edit);
        roster.append(edit);
      }
    }
    const selection = included();
    const selectedCount = sources.filter(source => selection.has(source.id)).length;
    count.textContent = selectedCount + ' of ' + listCount(sources.length);
    master.checked = draft.includedSourceIds === null;
    master.indeterminate = !master.checked && selectedCount > 0;
    clear.disabled = !selection.size && !master.checked;
    undo.disabled = !history.length;
    picker.update(selection);
  }

  function back() {
    if (!groupEditor) return cancel();
    groupEditor.remove();
    groupEditor = undefined;
    root.hidden = false;
    heading.textContent = 'TickTick calendars';
    footer.replaceChildren(undo, cancelRoot, saveRoot);
    (editButtons.get(groupTrigger) || add).focus({ preventScroll: true });
  }

  function editGroup(group) {
    groupTrigger = group?.id;
    clearError();
    root.hidden = true;
    groupEditor = element('div', 'ticktick-editor');
    heading.textContent = group ? 'Edit calendar' : 'Add calendar';
    const name = element('input');
    name.type = 'text';
    name.required = true;
    name.value = group?.name || '';
    name.placeholder = 'e.g. Work';
    const nameField = element('label', 'field');
    nameField.append(element('span', 'field-label', 'Calendar name'), name);

    const selected = new Set(group?.sourceIds);
    const owners = new Map(draft.groups.filter(other => other.id !== group?.id)
      .flatMap(other => other.sourceIds.map(id => [id, other.name])));
    const allowed = included();
    const listSection = element('section', 'included-lists');
    const top = element('div', 'section-top');
    const assigned = element('span', 'list-count');
    top.append(element('h3', 'field-label', 'Lists in this calendar'), assigned);
    const groupPicker = createListPicker(sources, (members, checked) => {
      toggleLists(selected, members, checked);
      updateSelection();
    }, source => [owners.has(source.id) ? 'In ' + owners.get(source.id) : '', allowed.has(source.id) ? '' : 'Excluded'].filter(Boolean).join(' · '));
    function updateSelection() {
      assigned.textContent = listCount(selected.size);
      groupPicker.update(selected);
    }
    listSection.append(top);
    if (owners.size) listSection.append(element('p', 'help', 'Selecting a list from another calendar moves it here.'));
    if (sources.some(source => !allowed.has(source.id))) listSection.append(element('p', 'help', 'Lists marked Excluded stay outside the calendar until included in settings.'));
    listSection.append(groupPicker.node);
    groupEditor.append(nameField, listSection);
    body.append(groupEditor);
    footer.replaceChildren();
    if (group) footer.append(button('Remove calendar', () => {
      change({ groups: draft.groups.filter(other => other.id !== group.id) });
      back();
    }, 'text-button danger-text left-action'));
    const done = () => {
      const title = name.value.trim();
      if (!title) name.setCustomValidity('Enter a calendar name.');
      if (!name.reportValidity()) return;
      const edited = { id: group?.id || crypto.randomUUID(), name: title, sourceIds: [...selected] };
      const groups = draft.groups.map(other => other.id === edited.id ? edited : {
        ...other, sourceIds: other.sourceIds.filter(id => !selected.has(id))
      });
      if (!group) groups.push(edited);
      change({ groups });
      groupTrigger = edited.id;
      back();
    };
    name.addEventListener('input', () => name.setCustomValidity(''));
    name.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); done(); }
    });
    footer.append(button('Cancel', back), button('Done', done, 'primary'));
    updateSelection();
    name.focus({ preventScroll: true });
  }

  updateRoot();
  modeButtons.get(draft.mode).focus({ preventScroll: true });
  return { back };
}
