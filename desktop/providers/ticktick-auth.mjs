import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const scopes = 'tasks:write tasks:read';
const issuerUrl = 'https://ticktick.com';
const registerUrl = 'https://api.ticktick.com/oauth/register';
const authorizeUrl = 'https://ticktick.com/oauth/authorize';
const tokenUrl = 'https://api.ticktick.com/oauth/token';

function authError(message) {
  return Object.assign(new Error(message), { code: 'AUTH_REQUIRED' });
}

function clientId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\s\x00-\x1f\x7f]/.test(value);
}

async function post(endpoint, body, fetchImpl, signal, registration) {
  const action = registration ? 'register Calendar Central' : 'finish sign-in';
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { Accept: 'application/json', 'Content-Type': registration ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: registration ? JSON.stringify(body) : body,
    });
  } catch {
    if (signal.aborted) throw authError('TickTick sign-in timed out. Start again.');
    throw authError('Could not reach TickTick to ' + action + '. Check your connection.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw authError('TickTick could not ' + action + ' (HTTP ' + response.status + '). You can also connect with a personal API token.');
  }
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw authError('TickTick returned an incomplete sign-in response.');
  return data;
}

async function readRegistration(file, endpoint) {
  if (!file) return null;
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw authError('Could not read the saved TickTick registration.'); }
  try {
    const saved = JSON.parse(text);
    if (saved.endpoint !== endpoint || !clientId(saved.clientId) || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535) return null;
    return saved;
  } catch { return null; }
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('listening', ready);
    server.once('error', failed);
    server.listen(port, '127.0.0.1');
  });
}

export async function authorizeTickTick({
  openExternal, registrationFile, fetchImpl = fetch, timeoutMs = 5 * 60_000, issuer = issuerUrl,
  registrationEndpoint = registerUrl, authEndpoint = authorizeUrl, tokenEndpoint = tokenUrl,
}) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const signal = AbortSignal.timeout(timeoutMs);
  const server = createServer();
  let registration = await readRegistration(registrationFile, registrationEndpoint);
  let accept;
  server.on('request', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Connection', 'close');
    if (accept) return accept(req, res);
    res.writeHead(404).end();
  });
  try {
    try { await listen(server, registration?.port ?? 0); }
    catch (error) {
      if (!registration || error.code !== 'EADDRINUSE') throw authError('Could not open the local TickTick sign-in window.');
      registration = null;
      await listen(server, 0);
    }
    const port = server.address().port;
    const redirect = new URL('http://127.0.0.1:' + port + '/callback');
    if (!registration) {
      const data = await post(registrationEndpoint, {
        client_name: 'Calendar Central', application_type: 'native', redirect_uris: [redirect.href],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: scopes,
      }, fetchImpl, signal, true);
      if (!clientId(data.client_id) || (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== 'none') ||
          (data.redirect_uris && (!Array.isArray(data.redirect_uris) || !data.redirect_uris.includes(redirect.href)))) {
        throw authError('TickTick did not register Calendar Central as a public Mac app. You can use a personal API token.');
      }
      registration = { endpoint: registrationEndpoint, clientId: data.client_id, port };
      if (registrationFile) {
        const temporary = registrationFile + '.' + randomUUID();
        await writeFile(temporary, JSON.stringify(registration), { mode: 0o600 });
        await rename(temporary, registrationFile);
      }
    }

    const url = new URL(authEndpoint);
    url.search = new URLSearchParams({
      client_id: registration.clientId, response_type: 'code', redirect_uri: redirect.href, scope: scopes,
      state, code_challenge_method: 'S256', code_challenge: challenge,
    });
    const code = await new Promise((resolve, reject) => {
      const timedOut = () => reject(authError('TickTick sign-in timed out. Start again.'));
      if (signal.aborted) return timedOut();
      signal.addEventListener('abort', timedOut, { once: true });
      accept = (request, response) => {
        let callback;
        try { callback = new URL(request.url, redirect); } catch { response.writeHead(400).end(); return; }
        const query = callback.searchParams;
        if (request.method !== 'GET' || request.headers.host !== redirect.host || callback.origin !== redirect.origin ||
            callback.pathname !== redirect.pathname || query.getAll('state').length !== 1 || query.get('state') !== state ||
            (query.has('iss') && (query.getAll('iss').length !== 1 || query.get('iss') !== issuer))) {
          response.writeHead(400).end('Invalid sign-in callback.'); return;
        }
        if (query.has('error')) {
          accept = null;
          response.writeHead(200).end('Return to Calendar Central. TickTick sign-in did not finish.');
          reject(authError(query.get('error') === 'access_denied' ? 'TickTick sign-in was cancelled.' : 'TickTick did not authorize this sign-in.')); return;
        }
        if (query.getAll('code').length !== 1 || !query.get('code')) {
          response.writeHead(400).end('Missing sign-in code.'); return;
        }
        accept = null;
        signal.removeEventListener('abort', timedOut);
        response.writeHead(200).end('You can close this tab and return to Calendar Central.');
        resolve(query.get('code'));
      };
      Promise.resolve().then(() => openExternal(url.href)).catch(() => reject(authError('Could not open TickTick sign-in in your browser.')));
    });
    const token = await post(tokenEndpoint, new URLSearchParams({
      grant_type: 'authorization_code', client_id: registration.clientId, code, code_verifier: verifier, redirect_uri: redirect.href, scope: scopes,
    }), fetchImpl, signal, false);
    if (typeof token.access_token !== 'string' || !token.access_token.trim() || /[\s\x00-\x1f\x7f]/.test(token.access_token) ||
        (token.token_type && String(token.token_type).toLowerCase() !== 'bearer')) {
      throw authError('TickTick did not return a bearer token.');
    }
    if (token.scope !== undefined && (typeof token.scope !== 'string' || !scopes.split(' ').every(s => token.scope.split(/\s+/).includes(s)))) {
      throw authError('Grant task read and write access when connecting TickTick.');
    }
    const seconds = Number(token.expires_in);
    return { token: token.access_token, clientId: registration.clientId,
      ...(Number.isFinite(seconds) && seconds > 0 ? { expiresAt: Date.now() + seconds * 1000 } : {}) };
  } finally {
    accept = null;
    server.close();
    server.closeAllConnections();
  }
}
