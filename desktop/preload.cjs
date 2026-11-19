const { contextBridge, ipcRenderer } = require('electron');

const operations = ['state', 'setAppearance', 'connect', 'renameConnection', 'macAccountCalendars', 'macGoogleCalendars', 'openInternetAccounts', 'disconnect', 'setSource',
  'configureTickTick', 'setTickTickCalendarVisible', 'setCalendarColor', 'setCalendarNotifications', 'save', 'complete', 'remove', 'hide', 'restore', 'acknowledge'];
const calendar = {};
for (const operation of operations) {
  calendar[operation] = async input => {
    const reply = await ipcRenderer.invoke('calendar:' + operation, input);
    if (!reply.ok) {
      const error = new Error(reply.message);
      error.code = reply.code;
      throw error;
    }
    return reply.value;
  };
}
contextBridge.exposeInMainWorld('calendar', calendar);
