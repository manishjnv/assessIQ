import type { FastifyInstance } from 'fastify';
import { registerGoogleSsoRoutes } from './google.js';
import { registerTotpRoutes } from './totp.js';
import { registerEmbedRoutes } from './embed.js';
import { registerApiKeysRoutes } from './api-keys.js';
import { registerEmbedSecretsRoutes } from './embed-secrets.js';
import { registerWhoamiRoutes } from './whoami.js';
import { registerLogoutRoutes } from './logout.js';

// Auth routes — Fastify wrappers around @assessiq/auth library functions.
// Each route file installs its own per-route preHandler chain via
// `authChain({...})` from ../../middleware/auth-chain.js so the addendum §9
// stack is authoritative for /api/auth/* paths.
//
// Spec sources: docs/03-api-contract.md § Auth, § Embed, § Admin api-keys,
// § Admin embed-secrets; docs/04-auth-flows.md Flows 1, 1a, 1b, 3, 4;
// modules/01-auth/SKILL.md § Decisions captured.

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  await registerGoogleSsoRoutes(app);
  await registerTotpRoutes(app);
  await registerEmbedRoutes(app);
  await registerApiKeysRoutes(app);
  await registerEmbedSecretsRoutes(app);
  await registerWhoamiRoutes(app);
  await registerLogoutRoutes(app);
}
