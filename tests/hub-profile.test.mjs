import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import electron from 'electron';

const execute = promisify(execFile);

test('Calendar Hub opens the saved Mac profile, provider grants and view under its new product name', {
  skip: process.platform !== 'darwin'
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'calendar-hub-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appData = join(root, 'Application Support');
  const directory = join(appData, 'Calendar Central');
  await mkdir(directory, { recursive: true });

  async function launch(name) {
    const source = join(root, name);
    await mkdir(source);
    const manifest = { name: name.toLowerCase().replace(' ', '-'), productName: name, version: '1.0.0', main: 'main.mjs' };
    const fixture = new URL('./fixtures/profile-upgrade.mjs', import.meta.url);
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(source, 'main.mjs'), 'import ' + JSON.stringify(fixture.href));
    await writeFile(join(source, 'index.html'), '<!doctype html><title>' + name + '</title>');
    await execute(electron, ['--use-mock-keychain', '--disable-background-networking',
      '--user-data-dir=' + join(root, 'bootstrap'), source], { timeout: 30000 });
  }

  await launch('Calendar Central');
  const previous = await readFile(join(directory, 'calendar.json'));
  const registration = await readFile(join(directory, 'ticktick-oauth-client.json'));
  await launch('Calendar Hub');
  assert.deepEqual(await readFile(join(directory, 'calendar.json')), previous);
  assert.deepEqual(await readFile(join(directory, 'ticktick-oauth-client.json')), registration);
  assert.deepEqual(await readdir(appData), ['Calendar Central']);
});
