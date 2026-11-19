import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGoogleDesktopClient } from '../desktop/google-client.mjs';
import './build-mac-helper.mjs';

if (process.platform !== 'darwin') throw new Error('Build the Mac app on macOS.');
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = await mkdtemp(join(tmpdir(), 'calendar-central-package-'));
try {
  const { devDependencies, scripts, ...manifest } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest));
  for (const folder of ['desktop', 'ui']) await cp(join(root, folder), join(staging, folder), { recursive: true });
  const google = readGoogleDesktopClient(process.env.CALENDAR_CENTRAL_GOOGLE_DESKTOP_CONFIG);
  if (google) await writeFile(join(staging, 'desktop/google-desktop.json'), JSON.stringify({
    installed: { client_id: google.clientId, client_secret: google.clientSecret }
  }));
  const calendarPermission = 'Show your selected calendars and save edits to the Google calendars you choose.';
  const [output] = await packager({
    dir: staging, name: manifest.productName, platform: 'darwin', arch: process.arch, electronVersion: devDependencies.electron,
    appBundleId: 'local.calendarcentral.desktop', appCategoryType: 'public.app-category.productivity',
    extendInfo: { NSCalendarsFullAccessUsageDescription: calendarPermission, NSCalendarsUsageDescription: calendarPermission },
    extraResource: join(root, 'build/native/calendar-mac'), asar: true, prune: false, overwrite: true,
    osxSign: { identity: '-', identityValidation: false, continueOnError: false,
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }) },
    out: join(root, 'build/packaged')
  });
  const app = join(output, manifest.productName + '.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(app);
} finally {
  await rm(staging, { recursive: true, force: true });
}
