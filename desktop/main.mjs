import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CalendarService } from './calendar-service.mjs';
import { Profile } from './profile.mjs';
import { createTickTick } from './providers/ticktick.mjs';
import { createGoogle, authorizeGoogle, refreshGoogleToken } from './providers/google.mjs';
import { createMacCalendar } from './providers/mac.mjs';

app.setName('Calendar Central');
const directory = path.dirname(fileURLToPath(import.meta.url));
const index = path.join(directory, '../ui/index.html');
const testArgument = process.argv.find(argument => argument.startsWith('--calendar-test-config='));
let testOrigin;
if (testArgument) {
  const configPath = path.resolve(testArgument.slice('--calendar-test-config='.length));
  const origin = new URL(JSON.parse(readFileSync(configPath, 'utf8')).origin);
  if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:' || !origin.port) throw new Error('Use a loopback test service.');
  testOrigin = origin.origin;
  const profilePath = path.join(path.dirname(configPath), 'profile');
  mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  app.setPath('userData', profilePath);
  app.commandLine.appendSwitch('use-mock-keychain');
}

const macHelper = app.isPackaged ? path.join(process.resourcesPath, 'calendar-mac') : path.join(directory, '../build/native/calendar-mac');
const registry = {
  async authorize(input) {
    if (input.provider === 'mac' && process.platform === 'darwin') return {};
    if (input.provider === 'ticktick') {
      const token = String(input.token || '').trim();
      if (!token) throw new Error('Enter a TickTick API token.');
      return { token };
    }
    if (input.provider !== 'google') throw new Error('This calendar provider is unavailable.');
    const clientId = String(input.clientId || '').trim(), clientSecret = String(input.clientSecret || '').trim();
    if (!clientId) throw new Error('Enter the Google desktop OAuth client ID.');
    let signIn;
    const openExternal = async url => {
      if (!testOrigin) return shell.openExternal(url);
      if (new URL(url).origin !== testOrigin) throw new Error('Unexpected test authorization service.');
      signIn = new BrowserWindow({ width: 520, height: 550, title: 'Test sign-in', webPreferences: { sandbox: true, contextIsolation: true } });
      signIn.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await signIn.loadURL(url);
    };
    try {
      const auth = await authorizeGoogle({ clientId, clientSecret, openExternal,
        ...(testOrigin && { authEndpoint: testOrigin + '/oauth/authorize', tokenEndpoint: testOrigin + '/oauth/token' }) });
      return { clientId, clientSecret, ...auth };
    } finally {
      if (signIn && !signIn.isDestroyed()) signIn.close();
    }
  },
  client(provider, secret) {
    if (provider === 'ticktick') return createTickTick({ token: secret.token, ...(testOrigin && { apiBase: testOrigin + '/tick/open/v1' }) });
    if (provider === 'mac') return createMacCalendar({ executable: macHelper });
    if (provider !== 'google') throw new Error('Unknown calendar provider.');
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
    const service = new CalendarService(new Profile(app.getPath('userData'), safeStorage), registry);
    for (const action of ['state', 'connect', 'disconnect', 'setSource', 'save', 'complete', 'remove', 'hide', 'restore', 'acknowledge']) {
      ipcMain.handle('calendar:' + action, async (event, input) => {
        if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
          || event.senderFrame.url !== pathToFileURL(index).href) throw new Error('Unknown calendar window.');
        try { return { ok: true, value: await service.run(action, input) }; }
        catch (error) { return { ok: false, message: error.message, code: error.code }; }
      });
    }
    await openWindow();
    app.on('activate', () => { if (!mainWindow) void openWindow(); });
  }).catch(error => { dialog.showErrorBox('Calendar Central could not start', error.message); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
