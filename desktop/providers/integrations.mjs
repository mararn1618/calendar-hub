import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readGoogleDesktopClient } from '../google-client.mjs';
import { authorizeGoogle, createGoogle, refreshGoogleToken } from './google.mjs';
import { createIntegrationRegistry } from './registry.mjs';
import { authorizeTickTick } from './ticktick-auth.mjs';
import { createTickTick } from './ticktick.mjs';

const hasId = value => typeof value === 'string' && value.trim().length > 0;

function tickTickIntegration({ inBrowser, profileDirectory, testOrigin }) {
  const tokenIdentity = ({ token }) => createHash('sha256').update(token).digest('hex');
  const authEndpoints = testOrigin && {
    registrationEndpoint: testOrigin + '/tick/oauth/register', authEndpoint: testOrigin + '/tick/oauth/authorize',
    tokenEndpoint: testOrigin + '/tick/oauth/token', issuer: testOrigin,
  };
  return {
    id: 'ticktick', name: 'TickTick', itemKind: 'task', routes: ['browser', 'token'],
    async authorize(input) {
      const token = String(input.token || '').trim();
      if (token) return { token };
      if (input.route === 'token') throw new Error('Enter your TickTick personal API token.');
      return inBrowser(openExternal => authorizeTickTick({
        openExternal, registrationFile: join(profileDirectory, 'ticktick-oauth-client.json'), ...authEndpoints,
      }));
    },
    client({ token, expiresAt }, { rateLimit, onRateLimitChange, requestStats, inboxProjectId } = {}) {
      return createTickTick({ token, expiresAt, rateLimit, onRateLimitChange, requestStats, inboxProjectId,
        ...(testOrigin && { apiBase: testOrigin + '/tick/open/v1' }) });
    },
    credentialIdentity: tokenIdentity, identity: tokenIdentity,
  };
}

function googleConfiguration(testOrigin, fixtureGoogleBrowser) {
  if (testOrigin) return { client: fixtureGoogleBrowser && { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret' } };
  try {
    const bundled = new URL('../google-desktop.json', import.meta.url);
    return { client: readGoogleDesktopClient() ?? (existsSync(bundled) ? readGoogleDesktopClient(bundled) : null) };
  } catch {
    return { error: 'The configured Google desktop client file could not be loaded.' };
  }
}

function macAccount(provider, name, nativeCalendar) {
  function client({ accountId, googleCalendarIds } = {}) {
    return nativeCalendar({ provider, accountId, googleCalendarIds });
  }
  const macAccountCalendars = options => client().authorize(options);
  async function calendarsFor(accountId, options) {
    if (!hasId(accountId)) throw new Error('Choose your ' + name + ' account from Apple Calendar.');
    const calendars = (await macAccountCalendars(options)).filter(row => row.accountId === accountId);
    if (!calendars.length) throw new Error('This ' + name + ' account is unavailable. Check Internet Accounts and choose again.');
    return calendars;
  }
  return { client, macAccountCalendars, calendarsFor, identity: ({ accountId }) => JSON.stringify([provider, 'mac', accountId]) };
}

function googleIntegration({ inBrowser, testOrigin }, configuredClient, mac, macRoutes) {
  const authEndpoints = testOrigin && { authEndpoint: testOrigin + '/oauth/authorize', tokenEndpoint: testOrigin + '/oauth/token' };
  async function authorizeMac(input, { legacyMac = false, savedGoogleCalendarIds = [] } = {}) {
    const ids = input.googleCalendarIds;
    const editing = hasId(input.connectionId);
    const saved = editing && Array.isArray(savedGoogleCalendarIds) ? savedGoogleCalendarIds.filter(hasId) : [];
    const chooseCalendar = 'Choose at least one calendar from your Google account.';
    if (!Array.isArray(ids) || !ids.every(hasId) || (!ids.length && !saved.length)) throw new Error(chooseCalendar);
    const legacy = legacyMac && editing && input.accountId === undefined;
    const access = { requestAccess: input.requestAccess !== false };
    const calendars = legacy ? await mac.macAccountCalendars(access) : await mac.calendarsFor(input.accountId, access);
    const available = new Set(calendars.map(calendar => calendar.id));
    const requested = new Set(ids);
    const selected = new Set(saved.filter(id => requested.has(id) || !available.has(id)));
    for (const id of requested) {
      if (!available.has(id) && !selected.has(id)) throw new Error('Check the selected calendars in your Google account and choose again.');
      selected.add(id);
    }
    if (!selected.size) throw new Error(chooseCalendar);
    return { route: 'mac', ...(!legacy && { accountId: input.accountId }), googleCalendarIds: [...selected] };
  }

  return {
    id: 'google', name: 'Google Calendar', itemKind: 'event',
    routes: [...(configuredClient ? ['browser'] : []), ...macRoutes, 'custom'],
    macAccountCalendars: mac.macAccountCalendars,
    async authorize(input, context) {
      if (input.route === 'mac') return authorizeMac(input, context);
      const client = input.clientId ? { clientId: String(input.clientId).trim(), clientSecret: String(input.clientSecret || '').trim() } : configuredClient;
      if (!client) throw new Error('Use your Google account in Apple Calendar or choose your own Google desktop client.');
      const auth = await inBrowser(openExternal => authorizeGoogle({ ...client, openExternal, ...authEndpoints }));
      return { ...client, ...auth };
    },
    client(secret) {
      if (secret.route === 'mac') return mac.client(secret);
      let current = { accessToken: secret.accessToken, expiresAt: secret.expiresAt }, pending;
      async function getAccessToken() {
        if (current.accessToken && current.expiresAt > Date.now() + 60_000) return current.accessToken;
        pending ??= refreshGoogleToken({ ...secret, ...authEndpoints })
          .then(result => current = result).finally(() => { pending = null; });
        return (await pending).accessToken;
      }
      return createGoogle({ getAccessToken, ...(testOrigin && { apiBase: testOrigin + '/google/calendar/v3' }) });
    },
    identity(secret, sources) {
      if (secret.route === 'mac') return secret.accountId === undefined ? 'google-via-apple-calendar' : mac.identity(secret);
      const primary = sources.find(source => source.primary)?.id;
      if (!hasId(primary)) throw new Error('Google did not return the primary calendar for this account. Connect Google again.');
      return primary;
    },
  };
}

function exchangeIntegration(mac, routes) {
  return {
    id: 'exchange', name: 'Exchange', itemKind: 'event', readOnly: true, routes,
    macAccountCalendars: mac.macAccountCalendars,
    async authorize({ accountId, route, requestAccess = true }) {
      if (route !== 'mac') throw new Error('Choose an Exchange account from Apple Calendar.');
      await mac.calendarsFor(accountId, { requestAccess });
      return { route, accountId };
    },
    client: mac.client,
    identity(secret, sources) {
      if (!sources.some(row => row.accountId === secret.accountId)) throw new Error('The selected Exchange account is no longer available on this Mac.');
      return mac.identity(secret);
    },
  };
}

function macIntegration(nativeCalendar, routes) {
  const client = () => nativeCalendar({ provider: 'mac' });
  return {
    id: 'mac', name: 'Mac calendars', itemKind: 'event', readOnly: true, routes,
    async authorize({ requestAccess = true }) { await client().authorize({ requestAccess }); return {}; },
    client,
    identity: () => 'this-mac',
  };
}

export function createDesktopRegistry({ inBrowser, profileDirectory, macCalendar, testOrigin, fixtureGoogleBrowser = true }) {
  function nativeCalendar(options) {
    if (!macCalendar) throw new Error('Open Calendar Hub on a Mac to use Apple Calendar.');
    return macCalendar(options);
  }
  const config = googleConfiguration(testOrigin, fixtureGoogleBrowser);
  const macRoutes = macCalendar ? ['mac'] : [];
  return createIntegrationRegistry([
    tickTickIntegration({ inBrowser, profileDirectory, testOrigin }),
    googleIntegration({ inBrowser, testOrigin }, config.client, macAccount('google', 'Google', nativeCalendar), macRoutes),
    exchangeIntegration(macAccount('exchange', 'Exchange', nativeCalendar), macRoutes),
    macIntegration(nativeCalendar, macRoutes),
  ], { googleBrowser: Boolean(config.client), macCalendars: Boolean(macCalendar), googleConfigError: config.error });
}
