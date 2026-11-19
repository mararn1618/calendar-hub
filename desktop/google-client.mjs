import { readFileSync } from 'node:fs';

export function readGoogleDesktopClient(file) {
  if (!file) return null;
  const { installed } = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof installed?.client_id !== 'string' || !installed.client_id.trim() ||
      (installed.client_secret != null && typeof installed.client_secret !== 'string')) {
    throw new Error('Choose a Google OAuth credentials file for a Desktop app.');
  }
  return { clientId: installed.client_id.trim(), clientSecret: installed.client_secret?.trim() || '' };
}
