/**
 * RW-84 — GET /api/me/progress route: 401 without a session, shape with one.
 * withTenant is faked (no DB); the DB-backed SQL is covered by
 * modules/06-attempt-engine/src/__tests__/candidate-progress.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { AppError, AuthnError } from "@assessiq/core";

const query = vi.fn();
vi.mock("@assessiq/tenancy", async (orig) => ({
  ...(await orig<typeof import("@assessiq/tenancy")>()),
  withTenant: (_t: string, fn: (c: unknown) => unknown) => fn({ query }),
}));

import { registerAttemptCandidateRoutes } from "@assessiq/attempt-engine";

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.toJson() });
    return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
  });
  const candidateOnly = async (req: { headers: Record<string, string | string[] | undefined>; session?: unknown }) => {
    if (req.headers["x-user"] === undefined) throw new AuthnError("no session");
    req.session = { tenantId: "t-1", userId: String(req.headers["x-user"]) };
  };
  await registerAttemptCandidateRoutes(app, { candidateOnly: [candidateOnly as never] });
  return app;
}

describe("GET /api/me/progress", () => {
  it("is 401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/me/progress" });
    expect(res.statusCode).toBe(401);
  });

  it("returns attempts, trend and subjects for the signed-in candidate", async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce({
        rows: [
          {
            attempt_id: "a1", assessment_id: "s1", assessment_name: "Maths", total_earned: "30", total_max: "40",
            auto_pct: "75.00", passing_score_pct: 60, released_at: new Date("2026-10-05T09:00:00Z"), credential_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ node_id: "n1", label: "Algebra", questions: 4, correct: 3 }] });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/me/progress", headers: { "x-user": "u-1" } });
    expect(res.statusCode).toBe(200);
    expect(query.mock.calls[0]![1]).toEqual(["u-1"]);
    expect(res.json()).toEqual({
      attempts: [
        {
          attempt_id: "a1", assessment_id: "s1", assessment_name: "Maths", released_at: "2026-10-05T09:00:00.000Z",
          total_earned: 30, total_max: 40, score_pct: 75, passing_score_pct: 60, passed: true, certificate: null,
        },
      ],
      trend: [75],
      subjects: [{ node_id: "n1", label: "Algebra", questions: 4, correct: 3, rate_pct: 75 }],
    });
  });
});
