import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function createMacCalendar({ executable }) {
  async function read(args) {
    const { stdout } = await execute(executable, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);
    return result;
  }
  return {
    sources: () => read(['sources']),
    items: (source, start, end) => read(['items', source.id, start, end])
  };
}
