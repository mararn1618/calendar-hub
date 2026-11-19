import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function configureAppIdentity(app, Menu, profileDirectory) {
  // Electron 45 takes the Mac Keychain service and account from the app name before ready.
  const storageName = 'Calendar Central';
  const productName = app.name;
  app.setName(storageName);
  const directory = profileDirectory ?? (app.commandLine.hasSwitch('user-data-dir')
    ? app.getPath('userData') : join(app.getPath('appData'), storageName));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);

  app.once('ready', () => {
    app.setName(productName);
    if (process.platform === 'darwin') {
      const roles = ['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu'];
      Menu.setApplicationMenu(Menu.buildFromTemplate(roles.map(role => ({ role }))));
    }
  });
}
