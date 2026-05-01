// Structurally-typed request/reply shapes for the 01-auth middleware stack.
// Mirrors the 02-tenancy approach: Phase 0 deliberately avoids a hard
// dependency on `fastify`. Route layer wires hooks into Fastify directly via
// `app.addHook("preHandler", handler)`. Tests construct these mocks by hand.

export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
  cookies?: Record<string, string>;
  session?: {
    id: string;
    userId: string;
    tenantId: string;
    role: "admin" | "reviewer" | "candidate";
    totpVerified: boolean;
    expiresAt: string;
    lastTotpAt: string | null;
  };
  apiKey?: {
    id: string;
    tenantId: string;
    scopes: string[];
  };
  ip?: string;
  requestId?: string;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface AuthReply {
  statusCode: number;
  code: (status: number) => AuthReply;
  header: (name: string, value: string | number) => AuthReply;
  send: (payload: unknown) => AuthReply;
}

export type AuthHook = (req: AuthRequest, reply: AuthReply) => Promise<void> | void;
