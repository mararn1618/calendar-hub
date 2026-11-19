export function createIntegrationRegistry(integrations, options = {}) {
  const byId = new Map();
  for (const integration of integrations) {
    if (byId.has(integration.id)) throw new Error('Duplicate calendar integration: ' + integration.id);
    byId.set(integration.id, integration);
  }

  function lookup(id) {
    const integration = byId.get(id);
    if (!integration) throw new Error('This calendar provider is unavailable.');
    return integration;
  }

  return {
    connectionOptions: {
      ...options,
      integrations: integrations.map(({ id, name, itemKind, routes, readOnly = false }) =>
        ({ id, name, itemKind, routes, readOnly, available: routes.length > 0 })),
    },
    async authorize(input, context) {
      return lookup(input.provider).authorize(input, context);
    },
    client(provider, secret) {
      return lookup(provider).client(secret);
    },
    identity(provider, secret, sources) {
      return lookup(provider).identity(secret, sources);
    },
    async macAccountCalendars(provider, options) {
      const integration = lookup(provider);
      if (!integration.macAccountCalendars) throw new Error('This provider does not use an Apple Calendar account picker.');
      return integration.macAccountCalendars(options);
    },
  };
}
