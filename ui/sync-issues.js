import { accountLabel } from './dom.js';

export function syncIssues({ health, connections }) {
  const failures = health.filter(entry => entry.state !== 'current');
  const accounts = [];
  for (const [id, entries] of Map.groupBy(failures, entry => entry.connectionId)) {
    const connection = connections.find(row => row.id === id);
    let label = connection ? accountLabel(connection, connections) : 'Calendar account';
    const provider = connection?.providerName;
    if (provider && !label.toLowerCase().includes(provider.toLowerCase())) label = provider + ' · ' + label;
    accounts.push({ label, tickTick: connection?.provider === 'ticktick', entries });
  }
  if (!accounts.length) return { accounts, summary: '' };
  if (accounts.length > 1) return { accounts, summary: `Calendar updates are delayed for ${accounts.length} accounts.` };

  const [{ label, tickTick, entries }] = accounts;
  const count = new Set(entries.map(entry => entry.sourceId).filter(Boolean)).size;
  const noun = tickTick ? 'list' : 'calendar';
  const affected = count ? count + ' ' + noun + (count === 1 ? '' : 's') : 'its ' + noun + 's';
  const reasons = new Set(entries.map(entry => entry.message));
  const reason = reasons.size === 1 ? entries[0].message : undefined;
  const summary = label + ' couldn’t refresh ' + affected + '.';
  return { accounts, summary: reason && reason.length <= 160 ? summary + ' ' + reason : summary };
}
