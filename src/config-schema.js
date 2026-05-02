/**
 * Context Engine configuration schema validation.
 * Uses Zod to validate environment variables at startup.
 */

import { z } from 'zod';

const StringBool = z.enum(['true', 'false', '1', '0', '']).transform((v) =>
  ['true', '1'].includes(v?.toLowerCase())
).or(z.boolean());

export const ContextEngineConfigSchema = z.object({
  // HTTP Server
  HTTP_HOST: z.string().default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8901),
  HTTP_SOCKET_PATH: z.string().optional().default('/tmp/openclaw-engine.sock'),

  // Security
  OPENCLAW_API_SECRET: z.string().min(1, 'OPENCLAW_API_SECRET is required in production'),

  // LLM Gateway (optional)
  SIDE_LLM_GATEWAY_URL: z.string().url().optional().or(z.literal('')),
  SIDE_LLM_GATEWAY_MODEL: z.string().default('k2p6'),

  // Memory Limits
  LOCALMEM_DAILY_WRITE_LIMIT: z.coerce.number().int().min(1).default(50),
  LOCALMEM_TENTATIVE_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  LOCALMEM_SESSION_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(60),
  LOCALMEM_FACT_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(180),

  // Auto Triage
  AUTOTRIAGE_RECOVERY_MS: z.coerce.number().int().min(1).default(1800000),
  TRIAGE_MIN_CONTENT_LENGTH: z.coerce.number().int().min(1).default(10),
  TRIAGE_MAX_CONTENT_LENGTH: z.coerce.number().int().min(1).default(500),

  // Wiki
  WIKI_SEARCH_CACHE_TTL_MS: z.coerce.number().int().min(1).default(300000),
  WIKI_BM25_THRESHOLD: z.coerce.number().int().min(1).default(200),
  WIKI_BM25_K1: z.coerce.number().min(0.1).default(1.5),
  WIKI_BM25_B: z.coerce.number().min(0.1).max(1.0).default(0.75),

  // Search Mode
  MEMORY_SEARCH_MODE: z.enum(['or-first', 'and-first']).default('or-first'),

  // Rate Limiting
  RATE_LIMIT_POINTS: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_DURATION: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_BLOCK_DURATION: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_UNIX_SOCKET_POINTS: z.coerce.number().int().min(1).default(200),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Debug
  DEBUG_EXPORT_ENABLED: StringBool.default(false),
  DEBUG_EXPORT_HISTORY_LIMIT: z.coerce.number().int().min(1).default(20),
  DEBUG_EXPORT_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(3),
});

/**
 * Validate environment variables against schema.
 * @param {Object} env - process.env or test overrides
 * @returns {{ success: boolean, config?: Object, errors?: string[] }}
 */
export function validateConfig(env = process.env) {
  const result = ContextEngineConfigSchema.safeParse(env);
  if (result.success) {
    return { success: true, config: result.data };
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`
  );
  return { success: false, errors };
}

export default { ContextEngineConfigSchema, validateConfig };
