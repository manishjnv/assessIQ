import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', { config: { skipAuth: true } }, async () => ({ status: 'ok' }));
}
