import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packager } from '@electron/packager';
import { buildMacNotificationAddon } from '../scripts/build-mac-helper.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = await mkdtemp(join(tmpdir(), 'calendar-hub-notification-smoke-'));
try {
  const name = 'Calendar Hub Notification Check';
  const source = join(staging, 'app');
  const native = join(staging, 'native');
  await mkdir(source);
  await buildMacNotificationAddon(native);
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'calendar-hub-notification-check', version: '1.0.0', main: 'main.mjs', type: 'module' }));
  await copyFile(join(root, 'tests/fixtures/notification-status.mjs'), join(source, 'main.mjs'));
  await copyFile(join(root, 'desktop/mac-notifications.mjs'), join(source, 'mac-notifications.mjs'));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const [directory] = await packager({
    dir: source, out: join(staging, 'out'), platform: 'darwin', arch: process.arch, name,
    electronVersion: manifest.devDependencies.electron, appBundleId: 'local.calendarhub.notificationcheck',
    extraResource: join(native, 'calendar-notifications.node'), extendInfo: { LSUIElement: true },
    asar: true, prune: false, osxSign: { identity: '-', identityValidation: false, continueOnError: false,
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }) },
  });
  const bundle = join(directory, name + '.app');
  await execute('codesign', ['--verify', '--deep', '--strict', bundle]);
  const { stdout } = await execute(join(bundle, 'Contents/MacOS', name), ['--user-data-dir=' + join(staging, 'profile')], { timeout: 30000 });
  const status = JSON.parse(stdout.trim());
  assert(status.packaged && status.process === 'browser');
  assert(['undetermined', 'allowed', 'denied'].includes(status.authorization));
  console.log('Packaged Mac notification authorization:', status.authorization);
} finally {
  await rm(staging, { recursive: true, force: true });
}
