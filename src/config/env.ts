import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  CRON_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("LeadFlow CRM <onboarding@resend.dev>"),
  DEMO_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Public app URL used in emailed links; FRONTEND_URL may list several allowed origins. */
export function appUrl() {
  return env().FRONTEND_URL.split(",")[0].trim().replace(/\/$/, "");
}

export function resetEnvCache() {
  cached = null;
}
