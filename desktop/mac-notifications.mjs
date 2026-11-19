import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pendingLimit = 64;

function nativeClient() {
  if (process.platform !== 'darwin') return null;
  const filename = 'calendar-notifications.node';
  const resource = process.resourcesPath && join(process.resourcesPath, filename);
  const path = resource && existsSync(resource) ? resource : fileURLToPath(new URL('../build/native/' + filename, import.meta.url));
  const invoke = createRequire(import.meta.url)(path);
  return (method, payload = null) => new Promise((resolve, reject) => {
    invoke(method, JSON.stringify(payload), (error, json) => {
      if (error) return reject(new Error(error));
      try { resolve(JSON.parse(json)); } catch (cause) { reject(cause); }
    });
  });
}

function upcomingReminders(reminders, now) {
  const upcoming = new Map();
  for (const { id, title, body, fireAt } of reminders) {
    const instant = Date.parse(fireAt);
    if (typeof id !== 'string' || !id || typeof title !== 'string' || typeof body !== 'string' || !Number.isFinite(instant)) {
      throw new Error('Cannot schedule an invalid Mac reminder.');
    }
    if (instant <= now) continue;
    const seconds = Math.ceil(instant / 1000);
    const signature = createHash('sha256').update(JSON.stringify([seconds, title, body])).digest('hex');
    if (upcoming.has(id) && upcoming.get(id).signature !== signature) throw new Error('Two reminders have the same ID.');
    upcoming.set(id, { id, title, body, seconds, signature });
  }
  return [...upcoming.values()].sort((a, b) => a.seconds - b.seconds || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function createMacNotificationCenter({ load = nativeClient, now = Date.now } = {}) {
  let invoke;
  let loadError;
  let updating = Promise.resolve();

  function client() {
    if (!invoke && !loadError) {
      try { invoke = load(); }
      catch (error) { loadError = error; }
    }
    if (!invoke) throw new Error('The Mac notification bridge is unavailable.', { cause: loadError });
    return invoke;
  }

  async function authorization() {
    let native;
    try { native = client(); } catch { return 'unavailable'; }
    return native('authorization');
  }

  async function reconcile(reminders) {
    const upcoming = upcomingReminders(reminders, now());
    const native = client();
    const snapshot = await native('snapshot');
    const delivered = new Map(snapshot.delivered.map(row => [row.id, row.signature]));
    const targets = upcoming.filter(row => delivered.get(row.id) !== row.signature)
      .slice(0, Math.max(0, pendingLimit - snapshot.otherPending));
    const desired = new Map(targets.map(row => [row.id, row]));
    const pending = new Map(snapshot.pending.map(row => [row.id, row.signature]));
    const canceled = [...pending.keys()].filter(id => !desired.has(id));
    if (canceled.length) await native('cancel', canceled);
    const changes = targets.filter(row => pending.get(row.id) !== row.signature);
    if (changes.length && await authorization() !== 'allowed') throw new Error('Mac notifications need permission in System Settings.');
    for (const reminder of changes) {
      if (reminder.seconds * 1000 > now()) await native('schedule', reminder);
    }
    if (!changes.length && !canceled.length) return;
    const confirmed = await native('snapshot');
    const scheduled = new Map(confirmed.pending.map(row => [row.id, row.signature]));
    const shown = new Map(confirmed.delivered.map(row => [row.id, row.signature]));
    if (canceled.some(id => scheduled.has(id)) || changes.some(row => row.seconds * 1000 > now() &&
      scheduled.get(row.id) !== row.signature && shown.get(row.id) !== row.signature)) {
      throw new Error('macOS could not confirm the updated reminder schedule.');
    }
  }

  return {
    authorization,
    async requestAuthorization() {
      let native;
      try { native = client(); } catch { return 'unavailable'; }
      return native('requestAuthorization');
    },
    replace(reminders) {
      const result = updating.then(() => reconcile(reminders));
      updating = result.catch(() => {});
      return result;
    },
  };
}
