import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform === 'darwin') {
  mkdirSync(root + 'build/native', { recursive: true });
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', process.arch === 'arm64' ? 'arm64-apple-macos14.0' : 'x86_64-apple-macos14.0',
    root + 'native/MacCalendars.swift', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
    '-Xlinker', root + 'native/CalendarUsage.plist', '-o', root + 'build/native/calendar-mac'], { stdio: 'inherit' });
}
