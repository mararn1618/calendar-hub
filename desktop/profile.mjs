import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class Profile {
  constructor(directory, encryption) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'calendar.json');
    this.encryption = encryption;
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (this.data.schema !== 1) throw new Error('This calendar profile needs a newer app.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { schema: 1, connections: [], sources: [], cache: {}, hidden: [], journal: [] };
    }
  }

  save() {
    const temporary = this.file + '.new';
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600, flush: true });
    renameSync(temporary, this.file);
  }

  seal(secret) {
    if (!Object.keys(secret).length) return null;
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Unlock the Mac keychain before connecting a calendar.');
    return this.encryption.encryptString(JSON.stringify(secret)).toString('base64');
  }

  open(connection) {
    if (connection.secret === null) return {};
    return JSON.parse(this.encryption.decryptString(Buffer.from(connection.secret, 'base64')));
  }
}
