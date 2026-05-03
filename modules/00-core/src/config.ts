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
    ANTHROPIC_API_KEY: z.string().optional(),
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
