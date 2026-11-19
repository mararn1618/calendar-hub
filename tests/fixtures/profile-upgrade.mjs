import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, Menu, safeStorage } from 'electron';
import { configureAppIdentity } from '../../desktop/app-identity.mjs';
import { Profile } from '../../desktop/profile.mjs';

const bootstrap = app.commandLine.getSwitchValue('user-data-dir');
assert(bootstrap && app.commandLine.hasSwitch('use-mock-keychain'));
const appData = join(dirname(bootstrap), 'Application Support');
const directory = join(appData, 'Calendar Central');
const legacy = app.name === 'Calendar Central';
app.setPath('appData', appData);
app.commandLine.removeSwitch('user-data-dir');
if (legacy) {
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
} else {
  configureAppIdentity(app, Menu);
}
assert.equal(app.name, 'Calendar Central');
app.dock.hide();

app.whenReady().then(async () => {
  assert.equal(app.getPath('userData'), directory);
  assert.equal(app.getPath('sessionData'), directory);
  const profile = new Profile(app.getPath('userData'), safeStorage);
  const sourceId = JSON.stringify(['google-account', 'work']);
  const grants = [{ clientId: 'fixture-client', refreshToken: 'fixture-refresh' }, { token: 'fixture-ticktick' }];
  const registration = { clientId: 'registered-client', endpoint: 'https://example.invalid/register', port: 49180 };
  const registrationFile = join(app.getPath('userData'), 'ticktick-oauth-client.json');
  const window = new BrowserWindow({ show: false });
  await window.loadFile(join(app.getAppPath(), 'index.html'));
  if (legacy) {
    profile.data.connections = [
      { id: 'google-account', provider: 'google', secret: profile.seal(grants[0]) },
      { id: 'tick-account', provider: 'ticktick', secret: profile.seal(grants[1]) },
    ];
    profile.data.sources = [{ id: sourceId, connectionId: 'google-account', remoteId: 'work', selected: true }];
    profile.data.hidden = [{ sourceId, id: 'hidden-event' }];
    profile.data.journal = [{ id: 'pending-write', sourceId }];
    profile.data.notificationPreferences = { [sourceId]: { enabled: true, leadMinutes: 25 } };
    profile.data.notificationRequestsPending = true;
    profile.save();
    writeFileSync(registrationFile, JSON.stringify(registration));
    await window.webContents.executeJavaScript("localStorage.setItem('view', 'next'); localStorage.setItem('next-days', '8')");
    window.webContents.session.flushStorageData();
  } else {
    assert.equal(app.name, 'Calendar Hub');
    const menu = Menu.getApplicationMenu().items[0];
    assert.equal(menu.label, 'Calendar Hub');
    for (const role of ['about', 'hide', 'quit']) {
      assert(menu.submenu.items.find(item => item.role === role)?.label.includes('Calendar Hub'), role);
    }
    assert.deepEqual(profile.data.connections.map(connection => profile.open(connection)), grants);
    assert.deepEqual(JSON.parse(readFileSync(registrationFile)), registration);
    assert.deepEqual(await window.webContents.executeJavaScript("[localStorage.getItem('view'), localStorage.getItem('next-days')]"), ['next', '8']);
  }
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
