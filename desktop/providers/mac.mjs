import { execFile } from 'node:child_process';

const writes = new Set(['create', 'update', 'remove']);
const failure = (code, message) => Object.assign(new Error(message), { code });
const unclear = () => failure('UNCERTAIN', 'Mac Calendar may have saved the change. Check the calendar before trying again.');

function runHelper(executable, args, input) {
  return new Promise((resolve, reject) => {
    const timeout = args[0] === 'authorize' ? 300_000 : 30_000;
    const child = execFile(executable, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (!error) return resolve(stdout);
      const notStarted = ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code);
      reject(writes.has(args[0]) && !notStarted ? unclear() : failure('NATIVE', 'Could not run the Mac calendar helper.'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

export function createMacCalendar({ executable, provider, accountId, googleCalendarIds, executeHelper = runHelper }) {
  const mode = provider ?? (Array.isArray(googleCalendarIds) ? 'google' : 'mac');
  const selected = mode === 'google' ? new Set(Array.isArray(googleCalendarIds) ? googleCalendarIds : []) : null;
  const scoped = mode !== 'mac' && accountId !== undefined;
  if (scoped && (typeof accountId !== 'string' || !accountId.length)) throw failure('INVALID', 'Choose an account on this Mac.');
  const account = scoped ? { accountId } : {};
  const scope = selected ? { ...account, googleCalendarIds: [...selected] } : account;

  async function call(args, input, selection = scope) {
    if (Object.keys(selection).length) args = [...args, JSON.stringify(selection)];
    let stdout;
    try { stdout = await executeHelper(executable, args, input); }
    catch (error) {
      if (error.code || !writes.has(args[0])) throw error;
      throw unclear();
    }
    let result;
    try { result = JSON.parse(stdout); } catch { throw writes.has(args[0]) ? unclear() : failure('NATIVE', 'Mac Calendar returned an incomplete response.'); }
    if (result?.error) throw failure(result.code || 'NATIVE', result.error);
    if (!writes.has(args[0]) && !Array.isArray(result)) throw failure('NATIVE', 'Mac Calendar returned an incomplete list.');
    return result;
  }

  function checkSource(source, write = false) {
    if (write && mode !== 'google') throw failure('READ_ONLY', 'This Mac calendar is read-only.');
    if ((mode === 'exchange' && !scoped) || (scoped && source?.accountId !== accountId)) {
      throw failure('UNSELECTED', 'Choose a calendar from the connected account.');
    }
    if (typeof source?.id !== 'string' || (selected && !selected.has(source.id))) {
      throw failure('UNSELECTED', 'Choose this calendar in the Google setup on this Mac.');
    }
    if (write && source.writable !== true) throw failure('READ_ONLY', 'This Mac calendar is read-only.');
  }

  function accountCalendars(rows) {
    const calendars = scoped ? rows.filter(row => row.accountId === accountId) : rows;
    return mode === 'google' ? calendars : calendars.map(row => ({ ...row, writable: false }));
  }

  async function write(action, source, original, draft, options = {}) {
    checkSource(source, true);
    const input = { notify: options.notify === true, occurrence: options.occurrence === true };
    if (original) {
      if (original.providerCalendarId !== source.id) throw failure('CONFLICT', 'Review this event on its original calendar.');
      input.original = { id: original.id, version: original.version, start: original.start, allDay: original.allDay };
    }
    if (draft) input.draft = { title: draft.title, start: draft.start, end: draft.end, allDay: draft.allDay };
    const result = await call([action, 'google', source.id], input);
    if (action === 'remove') {
      if (result?.removed !== true) throw unclear();
      return;
    }
    if (!result?.id || !result.version || result.providerCalendarId !== source.id) throw unclear();
    return result;
  }

  return {
    async authorize({ google = false, requestAccess = true } = {}) {
      const action = requestAccess ? 'authorize' : 'accounts';
      if (google && mode === 'mac') return call([action, 'google'], undefined, {});
      return accountCalendars(await call([action, mode], undefined, account));
    },
    async sources() {
      if (mode === 'exchange' && !accountId) return [];
      const calendars = accountCalendars(await call(['sources', mode]));
      return selected ? calendars.filter(row => selected.has(row.id)) : calendars;
    },
    items(source, start, end) {
      checkSource(source);
      return call(['items', mode, source.id, start, end]).then(rows => mode === 'google' ? rows :
        rows.map(row => ({ ...row, canEdit: false, canDelete: false, canComplete: false })));
    },
    create: (source, draft) => write('create', source, null, draft),
    update: (source, original, draft) => write('update', source, original, draft, draft),
    remove: (source, original, options) => write('remove', source, original, null, options),
  };
}
