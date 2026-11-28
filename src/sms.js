'use strict';
// SMS delivery is deliberately not wired to any gateway yet. This adapter is the seam:
// supply a gateway implementation factory and set SMS_GATEWAY=custom in the environment when ready.
// Password recovery stays email-only until a provider is configured and privacy-approved.

function createSmsGateway(env = process.env, logger = console) {
  const mode = String(env.SMS_GATEWAY || '').toLowerCase();
  if (!mode || mode === 'disabled') return { enabled: false, send: async () => false };
  if (mode === 'custom') {
    const factoryPath = env.SMS_GATEWAY_MODULE;
    if (!factoryPath) {
      logger.error('SMS_GATEWAY=custom requires SMS_GATEWAY_MODULE.');
      return { enabled: false, send: async () => false };
    }
    try {
      const factory = require(factoryPath);
      const send = factory(env);
      if (typeof send !== 'function') throw new Error('SMS gateway module did not return a send function.');
      return { enabled: true, send };
    } catch (err) {
      logger.error('SMS gateway failed to load:', err.message);
      return { enabled: false, send: async () => false };
    }
  }
  logger.error(`Unknown SMS_GATEWAY=${mode}; leaving SMS disabled.`);
  return { enabled: false, send: async () => false };
}

module.exports = { createSmsGateway };
