import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, safeStorage, shell } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CalendarService } from './calendar-service.mjs';
import { configureAppIdentity } from './app-identity.mjs';
import { Profile } from './profile.mjs';
import { createDesktopRegistry } from './providers/integrations.mjs';
import { createMacCalendar } from './providers/mac.mjs';
import { createMacNotificationCenter } from './mac-notifications.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const index = path.join(directory, '../ui/index.html');
const testArgument = process.argv.find(argument => argument.startsWith('--calendar-test-config='));
let testOrigin, testProfile;
let macFixture = false;
let browserFixture = true;
if (testArgument) {
  const configPath = path.resolve(testArgument.slice('--calendar-test-config='.length));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const origin = new URL(config.origin);
  if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:' || !origin.port) throw new Error('Use a loopback test service.');
  testOrigin = origin.origin;
  macFixture = config.macFixture === true;
  browserFixture = config.googleBrowser !== false;
  testProfile = path.join(path.dirname(configPath), 'profile');
  app.commandLine.appendSwitch('use-mock-keychain');
}
configureAppIdentity(app, Menu, testProfile);

const macHelper = app.isPackaged ? path.join(process.resourcesPath, 'calendar-mac') : path.join(directory, '../build/native/calendar-mac');
const nativeAvailable = process.platform === 'darwin' && (!testOrigin || macFixture);

function fixtureNotificationCenter(origin) {
  async function call(action, reminders) {
    const response = await fetch(origin + '/notification-center/' + action, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reminders ?? null)
    });
    if (!response.ok) throw new Error('The test notification center could not respond.');
    return response.json();
  }
  return {
    authorization: () => call('authorization'),
    requestAuthorization: () => call('request-authorization'),
    replace: reminders => call('replace', reminders),
  };
}

async function fixtureMacHelper(_executable, args, input) {
  const reply = await fetch(testOrigin + '/mac-helper', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args, input }) });
  if (!reply.ok) throw new Error('The test calendar could not respond.');
  return reply.text();
}

function macCalendar(options) {
  return createMacCalendar({ ...options, executable: macHelper, executeHelper: macFixture ? fixtureMacHelper : undefined });
}

async function inBrowser(authorize) {
  let signIn;
  const openExternal = async url => {
    if (!testOrigin) return shell.openExternal(url);
    if (new URL(url).origin !== testOrigin) throw new Error('Unexpected test authorization service.');
    signIn = new BrowserWindow({ width: 520, height: 550, title: 'Test sign-in', webPreferences: { sandbox: true, contextIsolation: true } });
    signIn.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await signIn.loadURL(url);
  };
  try { return await authorize(openExternal); }
  finally { if (signIn && !signIn.isDestroyed()) signIn.close(); }
}

let mainWindow;
function openWindow() {
  mainWindow = new BrowserWindow({
    title: 'Calendar Hub', width: 1430, height: 940, minWidth: 840, minHeight: 560,
    show: false, backgroundColor: '#ffffff', webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(directory, 'preload.cjs')
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(index).href) event.preventDefault(); });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow.loadFile(index);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    if (!app.isPackaged) app.dock?.setIcon(path.join(directory, '../assets/calendar-hub.png'));
    const profileDirectory = app.getPath('userData');
    const registry = createDesktopRegistry({
      inBrowser, profileDirectory, macCalendar: nativeAvailable ? macCalendar : undefined,
      testOrigin, fixtureGoogleBrowser: browserFixture,
    });
    registry.notificationCenter = testOrigin ? fixtureNotificationCenter(testOrigin) : createMacNotificationCenter();
    const service = new CalendarService(new Profile(profileDirectory, safeStorage), registry);
    let notificationTimer, notificationRefresh;
    let nextFullCheck = Date.now();
    let quitting = false;
    function scheduleNotificationCheck() {
      clearTimeout(notificationTimer);
      if (quitting || notificationRefresh) return;
      const tickTickCheck = service.nextTickTickNotificationCheckAt();
      const next = Math.min(nextFullCheck, tickTickCheck ?? Infinity);
      notificationTimer = setTimeout(() => refreshNotifications(Date.now() < nextFullCheck), Math.max(250, next - Date.now()));
      notificationTimer.unref();
    }
    function refreshNotifications(tickTickOnly = false) {
      if (notificationRefresh) return;
      if (!tickTickOnly) nextFullCheck = Date.now() + 5 * 60_000;
      notificationRefresh = service.run('refreshNotifications', { tickTickOnly })
        .catch(error => console.warn('Calendar notification refresh failed.', error.message))
        .finally(() => { notificationRefresh = undefined; scheduleNotificationCheck(); });
    }
    function resumeNotifications() {
      nextFullCheck = Date.now();
      refreshNotifications();
    }
    for (const action of ['state', 'setAppearance', 'connect', 'renameConnection', 'macAccountCalendars', 'macGoogleCalendars', 'openInternetAccounts',
      'openCalendarPrivacy', 'requestCalendarAccess', 'disconnect', 'setSource',
      'configureTickTick', 'setTickTickCalendarVisible', 'setTickTickSyncInterval', 'setCalendarColor', 'setCalendarNotifications', 'save', 'complete', 'remove', 'hide', 'restore', 'acknowledge']) {
      ipcMain.handle('calendar:' + action, async (event, input) => {
        if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
          || event.senderFrame.url !== pathToFileURL(index).href) throw new Error('Unknown calendar window.');
        try {
          if (action === 'setAppearance') {
            if (!['light', 'dark'].includes(input?.theme)) throw new Error('Choose Light or Dark.');
            nativeTheme.themeSource = input.theme;
            return { ok: true };
          }
          if (action === 'openInternetAccounts') {
            if (!nativeAvailable) throw new Error('Open System Settings on your Mac.');
            if (!testOrigin) await shell.openExternal('x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension');
            return { ok: true };
          }
          if (action === 'openCalendarPrivacy') {
            if (!nativeAvailable) throw new Error('Open System Settings on your Mac.');
            if (testOrigin) {
              const response = await fetch(testOrigin + '/system-settings/calendarPrivacy', {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000)
              });
              if (!response.ok) throw new Error('The test settings service could not respond.');
            } else {
              await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars');
            }
            return { ok: true };
          }
          if (action === 'requestCalendarAccess') {
            if (!nativeAvailable) throw new Error('Open Calendar Hub on a Mac to allow calendar access.');
            await macCalendar({ provider: 'mac' }).authorize();
            return { ok: true };
          }
          const value = await service.run(action, input);
          if (action !== 'state' || !input?.cachedOnly) scheduleNotificationCheck();
          return { ok: true, value };
        }
        catch (error) { return { ok: false, message: error.message, code: error.code }; }
      });
    }
    await openWindow();
    refreshNotifications();
    powerMonitor.on('resume', resumeNotifications);
    app.once('will-quit', () => {
      quitting = true;
      clearTimeout(notificationTimer);
      powerMonitor.off('resume', resumeNotifications);
    });
    app.on('activate', () => { if (!mainWindow) void openWindow(); });
  }).catch(error => { dialog.showErrorBox('Calendar Hub could not start', error.message); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
