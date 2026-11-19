export function inspectDestinations({ app }) {
  if (!app.isPackaged || process.argv.some(arg => arg.startsWith('--calendar-test-config='))) return { invalid: true };
  const fs = process.getBuiltinModule('fs');
  const file = process.getBuiltinModule('path').join(app.getPath('userData'), 'calendar.json');
  const { connections, sources } = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { connections: [], sources: [] };
  const eligible = sources.filter(source => ['google', 'ticktick'].includes(source.provider) &&
    source.selected && source.writable && !source.readOnly &&
    !(source.provider === 'ticktick' && (source.remote?.inbox || /^inbox(?:\d+)?$/.test(source.remoteId))));
  return { build: app.getVersion(), connected: connections.map(account => account.provider),
    choices: eligible.map(source => {
      const account = connections.find(row => row.id === source.connectionId);
      return { id: source.id, remoteId: source.remoteId, name: source.name, provider: source.provider,
        account: account?.name, route: account?.route === 'mac' ? 'mac' : 'api' };
    }) };
}

export function destinationState(kind, requested, inventory) {
  const choices = inventory.choices.filter(source => source.provider === kind);
  if (!inventory.connected.includes(kind)) return { status: 'unconfigured', choices: [] };
  if (!choices.length) return { status: 'select a writable test destination in Calendars', choices };
  if (!requested) return { status: 'choose a disposable destination for the live run', choices };
  const matches = choices.filter(source => [source.id, source.remoteId, source.name].includes(requested));
  if (matches.length === 1) return { status: 'ready', source: matches[0], choices };
  return { status: matches.length ? 'multiple matching destinations' : 'requested destination unavailable', choices };
}

// This control exists only in the verifier-driven window during setup.
export function offerDestinations({ states, named }) {
  const dialog = document.querySelector('#dialog[open]');
  if (!dialog || dialog.querySelector('h2')?.textContent !== 'Calendars') return {};
  const confirmed = window.calendarHubLiveDestinations ??= {};
  let picker = dialog.querySelector('#live-test-destinations');
  if (!picker) {
    picker = document.createElement('fieldset');
    picker.id = 'live-test-destinations';
    const legend = document.createElement('legend');
    legend.textContent = 'Disposable items for this live test';
    picker.append(legend);
    dialog.querySelector('.dialog-body').prepend(picker);
  }
  const kinds = Object.keys(states);
  for (const kind of kinds) {
    if (named[kind] || !states[kind].choices.length || confirmed[kind]) continue;
    let row = picker.querySelector('[data-provider="' + kind + '"]');
    const choices = states[kind].choices;
    const key = JSON.stringify(choices.map(source => source.id));
    if (row?.dataset.choices === key) continue;
    const previous = row?.querySelector('select')?.value || '';
    row?.remove();
    row = document.createElement('div');
    row.dataset.provider = kind;
    row.dataset.choices = key;
    const select = document.createElement('select');
    const label = kind === 'google' ? 'Disposable Google calendar' : 'Disposable TickTick list';
    select.setAttribute('aria-label', label);
    select.add(new Option('Choose a ' + (kind === 'google' ? 'test calendar' : 'test list'), ''));
    for (const source of choices) select.add(new Option(source.name + ' (' + source.account + ')', source.id));
    if (choices.some(source => source.id === previous)) select.value = previous;
    const use = document.createElement('button');
    use.type = 'button';
    use.textContent = 'Use for ' + (kind === 'google' ? 'Google' : 'TickTick') + ' test';
    use.disabled = !select.value;
    select.onchange = () => { use.disabled = !select.value; };
    use.onclick = () => { if (select.value) confirmed[kind] = select.value; };
    row.append(select, use);
    picker.append(row);
  }
  for (const row of picker.querySelectorAll('[data-provider]')) {
    if (!states[row.dataset.provider]?.choices.length || confirmed[row.dataset.provider]) row.remove();
  }
  picker.hidden = !picker.querySelector('select');
  return { ...confirmed };
}
