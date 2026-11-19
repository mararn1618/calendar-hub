import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './build-mac-helper.mjs';

if (process.platform !== 'darwin') throw new Error('Build the Mac app on macOS.');
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = await mkdtemp(join(tmpdir(), 'calendar-central-package-'));
try {
  const { devDependencies, scripts, ...manifest } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest));
  for (const folder of ['desktop', 'ui']) await cp(join(root, folder), join(staging, folder), { recursive: true });
  const [output] = await packager({
    dir: staging, name: manifest.productName, platform: 'darwin', arch: process.arch, electronVersion: devDependencies.electron,
    appBundleId: 'local.calendarcentral.desktop', appCategoryType: 'public.app-category.productivity',
    extendInfo: { NSCalendarsFullAccessUsageDescription: 'Show events from Mac calendars you select in Calendar Central.',
      NSCalendarsUsageDescription: 'Show events from Mac calendars you select in Calendar Central.' },
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
