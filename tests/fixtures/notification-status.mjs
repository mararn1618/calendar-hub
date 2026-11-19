import { app } from 'electron';
import { createMacNotificationCenter } from './mac-notifications.mjs';

app.whenReady().then(async () => {
  const authorization = await createMacNotificationCenter().authorization();
  console.log(JSON.stringify({ authorization, packaged: app.isPackaged, process: process.type }));
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
