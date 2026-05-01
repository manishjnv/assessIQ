import 'fastify';
import type { PoolClient } from 'pg';

declare module 'fastify' {
  interface FastifyRequest {
    assessiqCtx: {
      requestId: string;
      tenantId?: string;
      userId?: string;
      ip?: string;
      ua?: string;
    };
    session?: {
      tenantId: string;
      userId: string;
      role: 'admin' | 'reviewer' | 'candidate';
    };
    tenant?: { id: string };
    db?: PoolClient;
  }
}
