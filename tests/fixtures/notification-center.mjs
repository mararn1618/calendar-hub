export function createNotificationFixture() {
  const state = { authorization: 'undetermined', decision: 'allowed', prompts: 0, pending: new Map() };
  function call(path, contents) {
    if (path === '/notification-center/authorization') return state.authorization;
    if (path === '/notification-center/request-authorization') {
      state.prompts++;
      state.authorization = state.decision;
      return state.authorization;
    }
    if (path !== '/notification-center/replace') throw new Error('Unknown notification request.');
    const reminders = JSON.parse(contents);
    const pending = new Map(reminders.map(row => [row.id, row]));
    if (pending.size !== reminders.length || reminders.some(row => !row.title || !Number.isFinite(Date.parse(row.fireAt)))) {
      throw new Error('Invalid notification request.');
    }
    state.pending = pending;
    return { pending: pending.size };
  }
  return { state, call };
}
