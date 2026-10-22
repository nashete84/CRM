import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .default("false");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    /** Where the app is served from. Unsafe cookie-authenticated requests must come from here. */
    APP_ORIGIN: z.string().url().default("http://localhost:3000"),
    /** Signs short-lived cookies (OIDC login state). Not used for sessions, which are random tokens. */
    COOKIE_SECRET: z.string().min(32, "must be at least 32 characters"),
    TRUST_PROXY: bool,
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(43200).default(120),
    /** Email + password sign-in. Development only (DECISIONS.md D-009). */
    ALLOW_LOCAL_LOGIN: bool,
    /** Sign-in attempts allowed per client address per minute. */
    LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(10),
    OIDC_REDIRECT_URL: z.string().url().optional(),
    /** Lets OIDC talk to an http:// issuer. Only for tests against a local mock IdP. */
    OIDC_ALLOW_INSECURE_HTTP: bool,
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV !== "production") return;
    if (c.ALLOW_LOCAL_LOGIN)
      ctx.addIssue({
        code: "custom",
        path: ["ALLOW_LOCAL_LOGIN"],
        message: "not allowed in production",
      });
    if (c.OIDC_ALLOW_INSECURE_HTTP)
      ctx.addIssue({
        code: "custom",
        path: ["OIDC_ALLOW_INSECURE_HTTP"],
        message: "not allowed in production",
      });
    if (!c.APP_ORIGIN.startsWith("https://"))
      ctx.addIssue({
        code: "custom",
        path: ["APP_ORIGIN"],
        message: "must be https in production",
      });
  })
  .transform((c) => ({
    ...c,
    APP_ORIGIN: new URL(c.APP_ORIGIN).origin,
    OIDC_REDIRECT_URL: c.OIDC_REDIRECT_URL ?? `${new URL(c.APP_ORIGIN).origin}/auth/oidc/callback`,
  }));

export type Config = z.infer<typeof schema>;

/** Fails fast with every problem listed, instead of crashing later on first use. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  return parsed.data;
}
