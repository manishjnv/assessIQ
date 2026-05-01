import type { FastifyInstance } from 'fastify';
import { AppError, AuthnError, ValidationError } from '@assessiq/core';
import { verifyEmbedToken } from '@assessiq/auth';
import { publicAuthChain } from '../../middleware/auth-chain.js';

// GET /embed?token=<JWT> — host-app iframe entry point.
//
// Library's verifyEmbedToken enforces (addendum §5):
//   - algorithms: ["HS256"] — alg=none, alg=HS512, alg=RS256 all reject
//   - decode-header fast-reject before any DB call
//   - aud === "assessiq", required claims, exp - iat <= 600s, iat-future-skew <= 5s
//   - two-key rotation grace: active first, then most-recent rotated ONCE
//   - replay cache: SET aiq:embed:jti:<jti> 1 EX (exp - now) NX
//
// Phase 0 minimum behaviour on success: return 200 JSON with the verified
// claims so a host integration test can confirm the round-trip. Session
// minting + redirect to /embed-app is Phase 4 work (no embed SPA yet, no
// candidate user JIT-creation). The replay cache is still primed by the
// library's verify call, so Drill D (replay rejection) works against this
// Phase 0 surface — first call returns 200, second call returns 401.
//
// On any failure surface returns 401 with `details.code` distinguishing
// invalid-token vs replay (the library throws AuthnError uniformly; the
// route maps "jti replay" message hint to a distinct details.code).

export async function registerEmbedRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/embed',
    {
      config: { skipAuth: true },
      preHandler: publicAuthChain,
    },
    async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const token = q['token'];
      if (typeof token !== 'string' || token.length === 0) {
        throw new ValidationError('token query param required', {
          details: { code: 'MISSING_TOKEN' },
        });
      }

      try {
        const verified = await verifyEmbedToken(token);
        return {
          accepted: true,
          tenantId: verified.tenantId,
          assessmentId: verified.payload.assessment_id,
          // Phase 0 stub: candidate session not yet minted (Phase 4 work).
          // The replay cache IS populated by the library, so a second call
          // with the same token returns 401 — Drill D passes against this
          // surface even without candidate session JIT.
          sessionMinted: false,
        };
      } catch (err) {
        // The library throws AuthnError("invalid embed token") for everything:
        // alg mismatch, claim missing, signature fail, replay, lifetime cap.
        // Surface a uniform 401 with INVALID_TOKEN — clients shouldn't be able
        // to distinguish failure modes (information leak surface).
        if (err instanceof AuthnError) {
          throw new AppError(err.message, 'INVALID_TOKEN', 401);
        }
        throw err as Error;
      }
    },
  );
}
