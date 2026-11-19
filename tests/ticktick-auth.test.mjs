import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeTickTick } from '../desktop/providers/ticktick-auth.mjs';

async function issuerFixture(t) {
  const received = { registrations: [], tokens: [], authorizations: [] };
  let registration, authorization;
  let registrationStatus = 201, tokenBody = { access_token: 'local-fixture', token_type: 'bearer', scope: 'tasks:read tasks:write', expires_in: 3600 };
  const server = createServer(async (request, response) => {
    const raw = [];
    for await (const chunk of request) raw.push(chunk);
    const body = Buffer.concat(raw).toString();
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/register') {
      registration = JSON.parse(body);
      received.registrations.push(registration);
      response.writeHead(registrationStatus).end(JSON.stringify({ ...registration, client_id: 'public-fixture' })); return;
    }
    if (request.url === '/token') {
      const form = Object.fromEntries(new URLSearchParams(body));
      received.tokens.push(form);
      const valid = !request.headers.authorization && form.client_id === 'public-fixture' && !form.client_secret &&
        form.redirect_uri === registration.redirect_uris[0] && form.code === 'fixture-code' &&
        form.grant_type === 'authorization_code' && form.scope === 'tasks:write tasks:read' && !form.resource &&
        createHash('sha256').update(form.code_verifier).digest('base64url') === authorization.searchParams.get('code_challenge');
      response.writeHead(valid ? 200 : 400).end(JSON.stringify(valid ? tokenBody : { error: 'invalid_grant' })); return;
    }
    response.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const endpoints = { issuer: origin, registrationEndpoint: origin + '/register', authEndpoint: origin + '/authorize', tokenEndpoint: origin + '/token' };
  function callback(url) {
    authorization = new URL(url);
    received.authorizations.push(authorization);
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ code: 'fixture-code', state: authorization.searchParams.get('state'), iss: origin });
    return callback;
  }
  return { received, endpoints, callback, rejectRegistration() { registrationStatus = 403; }, tokens(body) { tokenBody = body; } };
}

test('registers the app, uses PKCE and reuses its public registration on the next sign-in', async t => {
  const issuer = await issuerFixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'calendar-ticktick-register-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registrationFile = join(directory, 'registration.json');
  const openExternal = url => fetch(issuer.callback(url));
  for (let i = 0; i < 2; i++) {
    const grant = await authorizeTickTick({ ...issuer.endpoints, registrationFile, openExternal });
    assert.equal(grant.token, 'local-fixture');
    assert.equal(grant.clientId, 'public-fixture');
    assert(grant.expiresAt > Date.now() + 3_590_000);
  }
  assert.equal(issuer.received.registrations.length, 1);
  assert.equal(issuer.received.tokens.length, 2);
  const [registration] = issuer.received.registrations;
  assert.equal(registration.client_name, 'Calendar Hub');
  assert.deepEqual(registration.grant_types, ['authorization_code']);
  assert.deepEqual(registration.response_types, ['code']);
  assert.equal(registration.token_endpoint_auth_method, 'none');
  assert.equal(registration.application_type, 'native');
  const callbacks = issuer.received.authorizations.map(url => url.searchParams);
  for (const params of callbacks) {
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.equal(params.get('client_id'), 'public-fixture');
    assert.equal(params.get('scope'), 'tasks:write tasks:read');
    assert.equal(params.has('resource'), false);
    assert.equal(params.has('code_verifier'), false);
    assert.equal(params.get('redirect_uri'), registration.redirect_uris[0]);
  }
  assert.notEqual(callbacks[0].get('state'), callbacks[1].get('state'));
  assert.notEqual(callbacks[0].get('code_challenge'), callbacks[1].get('code_challenge'));
  const saved = JSON.parse(await readFile(registrationFile));
  assert.deepEqual(Object.keys(saved).sort(), ['clientId', 'endpoint', 'port']);
  assert.equal(saved.clientId, 'public-fixture');
});

test('ignores invalid loopback callbacks until the actual browser consent arrives', async t => {
  const issuer = await issuerFixture(t);
  const statuses = [];
  let opened = '';
  const openExternal = async url => {
    opened = url;
    const good = issuer.callback(url);
    for (const [field, invalid] of [['state', 'invalid'], ['iss', 'https://elsewhere.invalid'], ['code', '']]) {
      const bad = new URL(good); bad.searchParams.set(field, invalid);
      statuses.push((await fetch(bad)).status);
    }
    const repeated = new URL(good); repeated.searchParams.append('state', 'duplicate');
    statuses.push((await fetch(repeated)).status);
    await fetch(good);
  };
  const result = await authorizeTickTick({ ...issuer.endpoints, openExternal });
  assert.equal(new URL(opened).pathname, '/authorize');
  assert.equal(result.token, 'local-fixture');
  assert.deepEqual(statuses, [400, 400, 400, 400]);
  assert.equal(issuer.received.tokens.length, 1);
});

test('reports consent denial, incomplete grants and failed registration without reusing credentials', async t => {
  const issuer = await issuerFixture(t);
  await assert.rejects(authorizeTickTick({ ...issuer.endpoints, openExternal: url => {
    const cancel = issuer.callback(url); cancel.searchParams.delete('code'); cancel.searchParams.set('error', 'access_denied');
    return fetch(cancel);
  } }), /cancelled/);
  assert.equal(issuer.received.tokens.length, 0);
  issuer.tokens({ token_type: 'bearer', access_token: 'local-fixture', scope: 'tasks:read' });
  await assert.rejects(authorizeTickTick({ ...issuer.endpoints, openExternal: url => fetch(issuer.callback(url)) }), /read and write/);
  issuer.rejectRegistration();
  let opened = false;
  await assert.rejects(authorizeTickTick({ ...issuer.endpoints, openExternal: () => { opened = true; } }), /personal API token/);
  assert.equal(opened, false);
});

test('closes its loopback listener on timeout', async t => {
  const issuer = await issuerFixture(t);
  let callback;
  await assert.rejects(authorizeTickTick({ ...issuer.endpoints, timeoutMs: 120,
    openExternal: url => { callback = issuer.callback(url); },
  }), /timed out/);
  await assert.rejects(fetch(callback));
  assert.equal(issuer.received.tokens.length, 0);
});
