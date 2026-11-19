import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const minimumMacOSVersion = '14.0';
const target = (process.arch === 'arm64' ? 'arm64' : 'x86_64') + '-apple-macos' + minimumMacOSVersion;

async function nodeHeaders(staging) {
  const candidates = [process.env.NODE_INCLUDE_DIR, resolve(dirname(process.execPath), '../include/node')];
  if (process.env.npm_config_nodedir) candidates.push(join(process.env.npm_config_nodedir, 'include/node'));
  const installed = candidates.find(path => path && existsSync(join(path, 'node_api.h')));
  if (installed) return installed;
  const version = process.version;
  const base = 'https://nodejs.org/dist/' + version + '/';
  const filename = 'node-' + version + '-headers.tar.gz';
  const [archive, sums] = await Promise.all([fetch(base + filename), fetch(base + 'SHASUMS256.txt')]);
  if (!archive.ok || !sums.ok) throw new Error('Could not read official Node headers. Set NODE_INCLUDE_DIR to a local Node include directory.');
  const bytes = Buffer.from(await archive.arrayBuffer());
  const expected = (await sums.text()).split('\n').find(line => line.endsWith('  ' + filename))?.split(' ')[0];
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node header checksum does not match.');
  const path = join(staging, filename);
  await writeFile(path, bytes);
  const directory = 'node-' + version + '/include/node';
  execFileSync('tar', ['-xzf', path, '-C', staging, directory]);
  return join(staging, directory);
}

export async function buildMacNotificationAddon(output) {
  const staging = await mkdtemp(join(tmpdir(), 'calendar-hub-headers-'));
  try {
    const headers = await nodeHeaders(staging);
    await mkdir(output, { recursive: true });
    execFileSync('xcrun', ['clang++', '-target', target, '-std=c++17', '-fobjc-arc', '-O2', '-DNAPI_VERSION=8',
      '-I', headers, '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'Foundation', '-framework', 'UserNotifications',
      join(root, 'native/MacNotifications.mm'), '-o', join(output, 'calendar-notifications.node')], { stdio: 'inherit' });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function buildMacHelpers(output) {
  if (process.platform !== 'darwin') return;
  await buildMacNotificationAddon(output);
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', target,
    join(root, 'native/MacCalendars.swift'), '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
    '-Xlinker', join(root, 'native/CalendarUsage.plist'), '-o', join(output, 'calendar-mac')], { stdio: 'inherit' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildMacHelpers(join(root, 'build/native'));
}
