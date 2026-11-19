const { contextBridge, ipcRenderer } = require('electron');

const operations = ['state', 'setAppearance', 'connect', 'renameConnection', 'macAccountCalendars', 'macGoogleCalendars', 'openInternetAccounts',
  'openCalendarPrivacy', 'requestCalendarAccess', 'disconnect', 'setSource',
  'configureTickTick', 'setTickTickCalendarVisible', 'setTickTickSyncInterval', 'setCalendarColor', 'setCalendarNotifications', 'save', 'complete', 'remove', 'hide', 'restore', 'acknowledge'];
const calendar = {
  invoke(operation, input) {
    if (!operations.includes(operation)) throw new Error('Choose an available calendar action.');
    return ipcRenderer.invoke('calendar:' + operation, input);
  }
};
calendar.writeItem = (operation, input) => {
  if (!['save', 'complete', 'remove'].includes(operation)) throw new Error('Choose a calendar item action.');
  return calendar.invoke(operation, input);
};
for (const operation of operations) {
  calendar[operation] = async input => {
    const reply = await calendar.invoke(operation, input);
    if (!reply.ok) {
      const error = new Error(reply.message);
      error.code = reply.code;
      throw error;
    }
    return reply.value;
  };
}
contextBridge.exposeInMainWorld('calendar', calendar);
