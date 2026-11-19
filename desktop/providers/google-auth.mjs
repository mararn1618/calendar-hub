import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const calendarScope = 'https://www.googleapis.com/auth/calendar';
const scopes = [calendarScope + '.calendarlist.readonly', calendarScope + '.events'];

function authError(message) {
  return Object.assign(new Error(message), { code: 'AUTH_REQUIRED' });
}

function clientForm(clientId, clientSecret) {
  if (typeof clientId !== 'string' || !clientId.trim()) {
    throw authError('Enter the client ID from a Google Desktop app OAuth client.');
  }
  const form = new URLSearchParams({ client_id: clientId.trim() });
  if (clientSecret?.trim()) form.set('client_secret', clientSecret.trim());
  return form;
}

async function exchange(form, endpoint, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Could not reach Google sign-in. Check your connection.');
  }
  if (response.status >= 500 || response.status === 429) {
    await response.body?.cancel();
    throw new Error('Google sign-in is temporarily unavailable. Try again later.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (data?.error === 'invalid_grant') throw authError('Google sign-in has expired. Connect Google again.');
    throw authError('Google rejected sign-in. Check the desktop client details and permissions.');
  }
  if (typeof data?.access_token !== 'string' || !data.access_token || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0) {
    throw authError('Google returned incomplete sign-in details. Connect Google again.');
  }
  if (typeof data.scope === 'string') {
    const granted = new Set(data.scope.split(/\s+/));
    if (!granted.has(calendarScope) && !scopes.every(scope => granted.has(scope))) {
      throw authError('Grant access to the calendar list and events when connecting Google.');
    }
  }
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    refreshToken: data.refresh_token,
  };
}

export async function refreshGoogleToken({ clientId, clientSecret, refreshToken, tokenEndpoint = tokenUrl, fetchImpl = fetch }) {
  if (typeof refreshToken !== 'string' || !refreshToken) throw authError('Connect Google to continue.');
  const form = clientForm(clientId, clientSecret);
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);
  const { accessToken, expiresAt } = await exchange(form, tokenEndpoint, fetchImpl);
  return { accessToken, expiresAt };
}

export async function authorizeGoogle({
  clientId, clientSecret, openExternal, authEndpoint = authorizationUrl, tokenEndpoint = tokenUrl,
  fetchImpl = fetch, timeoutMs = 5 * 60_000,
}) {
  const form = clientForm(clientId, clientSecret);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(authEndpoint);
  const server = createServer();
  let redirect;
  let timer;
  let used = false;

  try {
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(authError('Google sign-in timed out. Start again.')), timeoutMs);
      server.once('error', () => reject(authError('Could not open the local Google sign-in callback.')));
      server.on('request', (request, response) => {
        const reply = (status, message) => {
          response.writeHead(status, {
            'Content-Type': 'text/plain; charset=utf-8', Connection: 'close',
            'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
          });
          response.end(message);
        };
        let callback;
        try { callback = new URL(request.url, redirect); } catch { reply(400, 'Invalid sign-in callback.'); return; }
        if (used || request.method !== 'GET' || request.headers.host !== redirect.host ||
            callback.origin !== redirect.origin || callback.pathname !== '/' || callback.searchParams.getAll('state').length !== 1 ||
            callback.searchParams.get('state') !== state) {
          reply(400, 'Invalid sign-in callback.');
          return;
        }
        if (callback.searchParams.has('error')) {
          used = true;
          reply(400, 'Google sign-in was cancelled. You can close this tab.');
          reject(authError('Google sign-in was cancelled.'));
          return;
        }
        const code = callback.searchParams.get('code');
        if (!code || callback.searchParams.getAll('code').length !== 1) {
          reply(400, 'Missing sign-in code.');
          return;
        }
        used = true;
        reply(200, 'You can close this tab and return to Calendar Hub.');
        resolve(code);
      });
      server.listen(0, '127.0.0.1', () => {
        redirect = new URL('http://127.0.0.1:' + server.address().port + '/');
        url.search = new URLSearchParams({
          client_id: form.get('client_id'), redirect_uri: redirect.href, response_type: 'code',
          scope: scopes.join(' '), access_type: 'offline', prompt: 'consent select_account',
          code_challenge_method: 'S256', code_challenge: challenge, state,
        });
        Promise.resolve().then(() => openExternal(url.href)).catch(() => reject(authError('Could not open Google in your browser.')));
      });
    });
    form.set('grant_type', 'authorization_code');
    form.set('code', code);
    form.set('code_verifier', verifier);
    form.set('redirect_uri', redirect.href);
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
  const tokens = await exchange(form, tokenEndpoint, fetchImpl);
  if (typeof tokens.refreshToken !== 'string' || !tokens.refreshToken) {
    throw authError('Google did not grant offline access. Connect again and approve the requested access.');
  }
  return tokens;
}
