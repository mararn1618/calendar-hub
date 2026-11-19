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

export function createMacCalendar({ executable, googleCalendarIds, executeHelper = runHelper }) {
  const selected = Array.isArray(googleCalendarIds) ? new Set(googleCalendarIds) : null;
  const mode = selected ? 'google' : 'mac';

  async function call(args, input) {
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
    if (typeof source?.id !== 'string' || (selected && !selected.has(source.id))) {
      throw failure('UNSELECTED', 'Choose this calendar in the Google setup on this Mac.');
    }
    if (write && (!selected || source.writable !== true)) throw failure('READ_ONLY', 'This Mac calendar is read-only.');
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
    authorize: ({ google = false } = {}) => call(['authorize', google ? 'google' : 'mac']),
    async sources() {
      const rows = await call(['sources', mode]);
      return selected ? rows.filter(row => selected.has(row.id)) : rows.map(row => ({ ...row, writable: false }));
    },
    items(source, start, end) {
      checkSource(source);
      return call(['items', mode, source.id, start, end]);
    },
    create: (source, draft) => write('create', source, null, draft),
    update: (source, original, draft) => write('update', source, original, draft, draft),
    remove: (source, original, options) => write('remove', source, original, null, options),
  };
}
