import { app, BrowserWindow, dialog, ipcMain, powerMonitor, safeStorage, shell } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CalendarService } from './calendar-service.mjs';
import { Profile } from './profile.mjs';
import { readGoogleDesktopClient } from './google-client.mjs';
import { createTickTick } from './providers/ticktick.mjs';
import { authorizeTickTick } from './providers/ticktick-auth.mjs';
import { createGoogle, authorizeGoogle, refreshGoogleToken } from './providers/google.mjs';
import { createMacCalendar } from './providers/mac.mjs';
import { createMacNotificationCenter } from './mac-notifications.mjs';

app.setName('Calendar Central');
const directory = path.dirname(fileURLToPath(import.meta.url));
const index = path.join(directory, '../ui/index.html');
const testArgument = process.argv.find(argument => argument.startsWith('--calendar-test-config='));
let testOrigin;
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
  const profilePath = path.join(path.dirname(configPath), 'profile');
  mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  app.setPath('userData', profilePath);
  app.commandLine.appendSwitch('use-mock-keychain');
}

const macHelper = app.isPackaged ? path.join(process.resourcesPath, 'calendar-mac') : path.join(directory, '../build/native/calendar-mac');
const bundledGoogle = path.join(directory, 'google-desktop.json');
const googleConfigFile = process.env.CALENDAR_CENTRAL_GOOGLE_DESKTOP_CONFIG || (existsSync(bundledGoogle) ? bundledGoogle : null);
let googleClient, googleConfigError;
if (testOrigin) {
  if (browserFixture) googleClient = { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret' };
} else {
  try { googleClient = readGoogleDesktopClient(googleConfigFile); }
  catch { googleConfigError = 'The configured Google desktop client file could not be loaded.'; }
}
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

function macClient(googleCalendarIds) {
  if (testOrigin && !macFixture) throw new Error('Mac calendars are unavailable in this test profile.');
  const executeHelper = macFixture ? async (_executable, args, input) => {
    const reply = await fetch(testOrigin + '/mac-helper', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args, input }) });
    if (!reply.ok) throw new Error('The test calendar could not respond.');
    return reply.text();
  } : undefined;
  return createMacCalendar({ executable: macHelper, googleCalendarIds, executeHelper });
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

const registry = {
  connectionOptions: { googleBrowser: Boolean(googleClient), macCalendars: nativeAvailable, googleConfigError },
  macGoogleCalendars() {
    if (!nativeAvailable) throw new Error('Open Calendar Central on a Mac to choose Apple Calendar accounts.');
    return macClient().authorize({ google: true });
  },
  async authorize(input) {
    if (input.provider === 'mac' && nativeAvailable) {
      await macClient().authorize();
      return {};
    }
    if (input.provider === 'ticktick') {
      const token = String(input.token || '').trim();
      if (token) return { token };
      if (input.route === 'token') throw new Error('Enter your TickTick personal API token.');
      return inBrowser(openExternal => authorizeTickTick({ openExternal, registrationFile: path.join(app.getPath('userData'), 'ticktick-oauth-client.json'),
        ...(testOrigin && { registrationEndpoint: testOrigin + '/tick/oauth/register', authEndpoint: testOrigin + '/tick/oauth/authorize',
          tokenEndpoint: testOrigin + '/tick/oauth/token', issuer: testOrigin }) }));
    }
    if (input.provider !== 'google') throw new Error('This calendar provider is unavailable.');
    if (input.route === 'mac') {
      if (!nativeAvailable) throw new Error('Open Calendar Central on a Mac to use Apple Calendar.');
      const ids = input.googleCalendarIds;
      if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string' && id.length)) {
        throw new Error('Choose at least one calendar from your Google account.');
      }
      return { route: 'mac', googleCalendarIds: [...new Set(ids)] };
    }
    const client = input.clientId ? { clientId: String(input.clientId).trim(), clientSecret: String(input.clientSecret || '').trim() } : googleClient;
    if (!client) throw new Error('Use your Google account in Apple Calendar or choose your own Google desktop client.');
    const auth = await inBrowser(openExternal => authorizeGoogle({ ...client, openExternal,
      ...(testOrigin && { authEndpoint: testOrigin + '/oauth/authorize', tokenEndpoint: testOrigin + '/oauth/token' }) }));
    return { ...client, ...auth };
  },
  client(provider, secret) {
    if (provider === 'ticktick') return createTickTick({ token: secret.token, expiresAt: secret.expiresAt, ...(testOrigin && { apiBase: testOrigin + '/tick/open/v1' }) });
    if (provider === 'mac') return macClient();
    if (provider !== 'google') throw new Error('Unknown calendar provider.');
    if (secret.route === 'mac') return macClient(secret.googleCalendarIds);
    let current = { accessToken: secret.accessToken, expiresAt: secret.expiresAt }, pending;
    const getAccessToken = async () => {
      if (current.accessToken && current.expiresAt > Date.now() + 60_000) return current.accessToken;
      pending ??= refreshGoogleToken({ ...secret, ...(testOrigin && { tokenEndpoint: testOrigin + '/oauth/token' }) })
        .then(result => current = result).finally(() => { pending = null; });
      return (await pending).accessToken;
    };
    return createGoogle({ getAccessToken, ...(testOrigin && { apiBase: testOrigin + '/google/calendar/v3' }) });
  },
  identity(provider, secret, sources) {
    if (provider === 'mac') return 'this-mac';
    if (provider === 'google' && secret.route === 'mac') return 'google-via-apple-calendar';
    const primary = sources.find(source => source.primary)?.id;
    if (provider === 'google' && primary) return primary;
    return createHash('sha256').update(secret.token ?? secret.refreshToken).digest('hex');
  }
};

let mainWindow;
function openWindow() {
  mainWindow = new BrowserWindow({
    title: 'Calendar Central', width: 1430, height: 940, minWidth: 840, minHeight: 560,
    backgroundColor: '#f8fafb', webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(directory, 'preload.cjs')
    }
  });
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
    if (!app.isPackaged) app.dock?.setIcon(path.join(directory, '../assets/calendar-central.png'));
    registry.notificationCenter = testOrigin ? fixtureNotificationCenter(testOrigin) : createMacNotificationCenter();
    const service = new CalendarService(new Profile(app.getPath('userData'), safeStorage), registry);
    for (const action of ['state', 'connect', 'macGoogleCalendars', 'openInternetAccounts', 'disconnect', 'setSource',
      'configureTickTick', 'setTickTickCalendarVisible', 'setCalendarNotifications', 'save', 'complete', 'remove', 'hide', 'restore', 'acknowledge']) {
      ipcMain.handle('calendar:' + action, async (event, input) => {
        if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
          || event.senderFrame.url !== pathToFileURL(index).href) throw new Error('Unknown calendar window.');
        try {
          if (action === 'openInternetAccounts') {
            if (!nativeAvailable) throw new Error('Open System Settings on your Mac.');
            if (!testOrigin) await shell.openExternal('x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension');
            return { ok: true };
          }
          return { ok: true, value: await service.run(action, input) };
        }
        catch (error) { return { ok: false, message: error.message, code: error.code }; }
      });
    }
    await openWindow();
    let notificationRefresh;
    function refreshNotifications() {
      notificationRefresh ??= service.run('refreshNotifications')
        .catch(error => console.warn('Calendar notification refresh failed.', error.message))
        .finally(() => { notificationRefresh = undefined; });
    }
    refreshNotifications();
    const timer = setInterval(refreshNotifications, 5 * 60_000);
    timer.unref();
    powerMonitor.on('resume', refreshNotifications);
    app.once('will-quit', () => {
      clearInterval(timer);
      powerMonitor.off('resume', refreshNotifications);
    });
    app.on('activate', () => { if (!mainWindow) void openWindow(); });
  }).catch(error => { dialog.showErrorBox('Calendar Central could not start', error.message); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
