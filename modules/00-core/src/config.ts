import { z } from "zod";

/**
 * Validates that a base64 string decodes to exactly 32 bytes.
 */
function is32ByteBase64(value: string): boolean {
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

const ConfigSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .default("info"),
    /**
     * Absolute directory where per-stream JSONL log files are written.
     * When unset, logger writes only to stdout (test/dev default).
     * When set (typically `/var/log/assessiq` in production), logger fans
     * out to `<LOG_DIR>/<stream>.log` plus `<LOG_DIR>/error.log` mirror.
     * See docs/11-observability.md § Streams & paths.
     */
    LOG_DIR: z.string().optional(),
    ASSESSIQ_BASE_URL: z
      .string()
      .url()
      .default("https://assessiq.automateedge.cloud"),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
        { message: "DATABASE_URL must start with postgres:// or postgresql://" }
      ),
    REDIS_URL: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith("redis://") || v.startsWith("rediss://"),
        { message: "REDIS_URL must start with redis:// or rediss://" }
      ),
    ASSESSIQ_MASTER_KEY: z
      .string()
      .min(1)
      .refine(is32ByteBase64, {
        message:
          "ASSESSIQ_MASTER_KEY must be a base64 string that decodes to exactly 32 bytes",
      }),
    SESSION_SECRET: z
      .string()
      .min(1)
      .refine(is32ByteBase64, {
        message:
          "SESSION_SECRET must be a base64 string that decodes to exactly 32 bytes",
      }),
    SESSION_COOKIE_NAME: z.string().default("aiq_sess"),
    EMBED_JWT_SECRET_PROVISION_MODE: z
      .enum(["per-tenant"])
      .default("per-tenant"),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_OAUTH_REDIRECT: z.string().url().optional(),
    // MFA gate. true (default) = admins/reviewers must complete TOTP after
    // Google SSO before accessing protected routes. false = Google SSO is
    // the sole auth factor; pre-MFA sessions are accepted by requireAuth
    // and the SSO callback redirects past /admin/mfa to returnTo. The flag
    // is read by modules/01-auth/src/middleware/require-auth.ts and
    // modules/01-auth/src/google-sso.ts. Flip to true for production
    // hardening; until then, /admin/mfa remains reachable for opt-in
    // enrollment from a future account-settings page.
    MFA_REQUIRED: z
      .enum(["true", "false"])
      .default("true")
      .transform((s) => s === "true"),
    SMTP_URL: z.string().optional(),
    EMAIL_FROM: z
      .string()
      .default("AssessIQ <noreply@automateedge.cloud>"),
    SENTRY_DSN: z.string().optional(),
    AI_PIPELINE_MODE: z
      .enum(["claude-code-vps", "anthropic-api", "open-weights"])
      .default("claude-code-vps"),
    /**
     * Stage 1 of type-sharded generation. 'omnibus' uses the legacy
     * generate-questions skill for all types in one call; 'sharded' fans out
     * to per-type skills (generate-mcq, generate-log-analysis,
     * generate-scenario, generate-kql) with auto-weighted counts and a
     * 2-concurrent semaphore.
     * See docs/design/2026-05-09-type-sharded-generation.md.
     *
     * Do NOT set to 'sharded' in .env in production until per-type skills are
     * deployed to ~/.claude/skills/ on the VPS and Stage 1.5 evals pass.
     */
    AI_GENERATE_MODE: z
      .enum(["omnibus", "sharded"])
      .default("omnibus"),
    ANTHROPIC_API_KEY: z.string().optional(),
    // Dev-only E2E session minter — POST /api/dev/mint-session.
    // When "true", the route is registered at server startup.
    // MUST be absent (or "false") in production .env.
    // See apps/web/e2e/README.md and docs/06-deployment.md § E2E test minter.
    ENABLE_E2E_TEST_MINTER: z
      .enum(["true", "false"])
      .default("false")
      .transform((s) => s === "true"),

    // ── Super-admin platform login ──────────────────────────────────────────
    //
    // PLATFORM_TENANT_ID: the fixed well-known UUID for the platform tenant.
    // Seeded in modules/01-auth/migrations/016_super_admin.sql.
    // The API server asserts at startup that this matches the DB row.
    // Must be set in production .env; defaults to the fixed seed UUID.
    PLATFORM_TENANT_ID: z
      .string()
      .default("00000000-0000-7000-0000-000000000001"),

    // SUPER_ADMIN_EMAILS: comma-separated list of email addresses allowed to
    // log in as super_admin. Gate 2 of the 4-gate platform login. Case-insensitive
    // after normalizeEmail() is applied to both sides.
    // Example: "manishjnvk@gmail.com,backup@example.com"
    SUPER_ADMIN_EMAILS: z.string().default("manishjnvk@gmail.com"),

    // ── Role-aware IP rate-limit tiers (window fixed at 60s) ────────────────
    // All vars are optional with safe defaults — zero-config deploy works.
    // Override in .env to tune without a rebuild.
    // See modules/01-auth/src/middleware/rate-limit.ts § resolveIpBucketMax.
    //
    // Admin + reviewer share one bucket (privileged staff; unlikely to brute-force).
    RATE_LIMIT_IP_ADMIN: z.coerce.number().int().positive().default(100),
    // Candidates (session role='candidate') and unknown session roles.
    RATE_LIMIT_IP_USER: z.coerce.number().int().positive().default(30),
    // Anonymous requests: no session cookie, no API key.
    RATE_LIMIT_IP_ANON: z.coerce.number().int().positive().default(30),
    // API-key-backed traffic: batch integrations, webhooks, server-to-server.
    RATE_LIMIT_IP_APIKEY: z.coerce.number().int().positive().default(600),
    // Per-IP cap for (role∈{admin,reviewer,super_admin}) && totpVerified===true.
    // This is a DoS ceiling only — per-user + per-tenant + per-route credential
    // caps are the actual constraints for verified admins. Set high so legitimate
    // admin navigation never hits this limit.
    RATE_LIMIT_IP_VERIFIED_ADMIN: z.coerce.number().int().positive().default(5000),
    // Per-user cap for verified-admin sessions (role∈{admin,reviewer,super_admin}
    // && totpVerified===true). Pre-MFA admin / candidates stay at 60 (hardcoded).
    RATE_LIMIT_USER_VERIFIED_ADMIN: z.coerce.number().int().positive().default(300),
    // Per-route per-IP cap for credential endpoints (TOTP verify, recovery,
    // enroll/confirm, login email request/verify). ALWAYS applies regardless of
    // auth tier — even verified admins hit it. Use to maintain brute-force
    // protection on credential paths while lifting the general IP cap for admins.
    RATE_LIMIT_CREDENTIAL: z.coerce.number().int().positive().default(20),

    // ── Origin-verify anti-IP-spoof ─────────────────────────────────────────
    //
    // Production topology: Cloudflare (DNS-proxy) → shared Caddy → assessiq-api
    // (Fastify). The origin IP :443 is directly reachable, so an attacker can
    // bypass Cloudflare and spoof any cf-connecting-ip value. The origin-verify
    // mechanism mitigates this: Cloudflare injects a shared secret as the
    // x-origin-verify request header via a Transform Rule. The API only trusts
    // cf-connecting-ip when that header matches the secret.
    //
    // ORIGIN_VERIFY_SECRET: shared secret Cloudflare injects as the
    // x-origin-verify request header. Optional so dev/test/CI boot without it,
    // but when present it must be ≥16 chars — an empty/short secret would make
    // the constant-time compare trivially satisfiable (adversarial finding 6).
    ORIGIN_VERIFY_SECRET: z
      .string()
      .min(16, "ORIGIN_VERIFY_SECRET must be ≥16 chars when set")
      .optional(),

    // ORIGIN_TRUST_MODE: three-stage rollout gate.
    //   off     — legacy behaviour: trust cf-connecting-ip ?? req.ip with zero
    //             validation. Zero-behavior-change deploy until ops flips it.
    //   log     — same return value as off (cf ?? req.ip), but emits a structured
    //             warn when the x-origin-verify header is absent or mismatched.
    //             Use to confirm the CF Transform Rule is in place before enforce.
    //   enforce — only trusts cf-connecting-ip when x-origin-verify passes a
    //             constant-time compare against ORIGIN_VERIFY_SECRET. If the
    //             compare fails, falls back to the raw socket IP and ignores
    //             cf-connecting-ip / x-forwarded-for entirely.
    // Rollout order: off → log (confirm headers in prod logs) → enforce.
    ORIGIN_TRUST_MODE: z
      .enum(["off", "log", "enforce"])
      .default("off"),
  })
  .superRefine((data, ctx) => {
    if (
      data.AI_PIPELINE_MODE === "anthropic-api" &&
      !data.ANTHROPIC_API_KEY
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "ANTHROPIC_API_KEY is required when AI_PIPELINE_MODE=anthropic-api",
        path: ["ANTHROPIC_API_KEY"],
      });
    }
    if (
      data.AI_PIPELINE_MODE === "claude-code-vps" &&
      data.ANTHROPIC_API_KEY
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "ANTHROPIC_API_KEY must NOT be set when AI_PIPELINE_MODE=claude-code-vps " +
          "(ambient AI calls are forbidden per CLAUDE.md rule #1)",
        path: ["ANTHROPIC_API_KEY"],
      });
    }
    // Adversarial finding 1 (CRITICAL): ORIGIN_TRUST_MODE=enforce with no
    // ORIGIN_VERIFY_SECRET makes isOriginVerified() return false for EVERY
    // request → the rate-limit fail-closed path throws on every request →
    // total global outage. Refuse to boot instead: a failed config load means
    // the new container never goes healthy and the old one keeps serving (loud,
    // recoverable) rather than a silent site-wide 429 (catastrophic). log/off
    // with no secret is fine — log only warns, off is legacy passthrough.
    if (
      data.ORIGIN_TRUST_MODE === "enforce" &&
      (data.ORIGIN_VERIFY_SECRET === undefined ||
        data.ORIGIN_VERIFY_SECRET.length < 16)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "ORIGIN_TRUST_MODE=enforce requires a ≥16-char ORIGIN_VERIFY_SECRET. " +
          "Set the secret (and the matching Cloudflare Transform Rule) BEFORE " +
          "switching to enforce. Rollout order: off → log → enforce.",
        path: ["ORIGIN_TRUST_MODE"],
      });
    }
    if (
      data.NODE_ENV === "production" &&
      data.ENABLE_E2E_TEST_MINTER === true
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "ENABLE_E2E_TEST_MINTER MUST be false in production. The dev session " +
          "minter bypasses Google SSO + TOTP and must never be reachable in prod.",
        path: ["ENABLE_E2E_TEST_MINTER"],
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  return result.data;
}

export const config: Config = loadConfig();
