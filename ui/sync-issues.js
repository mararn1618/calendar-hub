import { accountLabel } from './dom.js';

const macAccess = new Map([
  ['CALENDAR_ACCESS', { label: 'Open Calendar Privacy Settings',
    message: 'To sync Mac calendars, turn on Calendar Hub in Calendars, then choose Full Access under Options.' }],
  ['CALENDAR_ACCESS_NOT_REQUESTED', { label: 'Allow Calendar Access', request: true,
    message: 'To sync Mac calendars, allow Calendar Hub access. Choose Allow Full Access when macOS asks.' }],
  ['CALENDAR_ACCESS_RESTRICTED', { label: 'Open Calendar Privacy Settings',
    message: 'Your Mac restricts calendar access. Ask your administrator to allow Calendar Hub Full Access.' }],
]);

export const macCalendarAccess = code => macAccess.get(code);

function accountSummary(accounts) {
  if (!accounts.length) return '';
  if (accounts.length > 1) return `Calendar updates are delayed for ${accounts.length} accounts.`;

  const [{ label, tickTick, entries }] = accounts;
  const count = new Set(entries.map(entry => entry.sourceId).filter(Boolean)).size;
  const noun = tickTick ? 'list' : 'calendar';
  const affected = count ? count + ' ' + noun + (count === 1 ? '' : 's') : 'its ' + noun + 's';
  const reasons = new Set(entries.map(entry => entry.message));
  const reason = reasons.size === 1 ? entries[0].message : undefined;
  const summary = label + ' couldn’t refresh ' + affected + '.';
  return reason && reason.length <= 160 ? summary + ' ' + reason : summary;
}

export function syncIssues({ health, connections, notificationFailures = [] }) {
  const failures = health.filter(entry => entry.state !== 'current')
    .concat(notificationFailures.map(entry => ({ ...entry, reminder: true })));
  const accounts = [];
  const otherAccounts = [];
  let access, tickTickLimited = false;
  for (const [id, entries] of Map.groupBy(failures, entry => entry.connectionId)) {
    const connection = connections.find(row => row.id === id);
    let label = connection ? accountLabel(connection, connections) : 'Calendar account';
    const provider = connection?.providerName;
    if (provider && !label.toLowerCase().includes(provider.toLowerCase())) label = provider + ' · ' + label;
    const account = { label, tickTick: connection?.provider === 'ticktick', entries };
    accounts.push(account);
    const other = entries.filter(entry => {
      const permission = macCalendarAccess(entry.code);
      if (permission) { access ??= permission; return false; }
      if (account.tickTick && entry.code === 'RATE_LIMITED') { tickTickLimited = true; return false; }
      return !entry.reminder || entry.code === 'RATE_LIMITED';
    });
    if (other.length) otherAccounts.push({ ...account, entries: other });
  }
  const summary = [tickTickLimited && 'TickTick reached its request limit. Calendar Hub will retry automatically.',
    accountSummary(otherAccounts)].filter(Boolean).join(' ');
  return { accounts, summary, ...(access && { macAccess: access }) };
}
