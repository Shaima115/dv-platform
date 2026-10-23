import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z, type ZodTypeAny } from 'zod';

/**
 * Loads a dotenv file into process.env when one exists (development convenience).
 * Variables already present in the environment always win, so PM2 or systemd values override the file.
 */
export function loadDotEnvIfPresent(
  path = process.env.DOTENV_PATH ?? resolve(process.cwd(), '.env'),
): void {
  if (!existsSync(path)) {
    return;
  }
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined && value !== undefined) {
      process.env[key] = value;
    }
  }
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates configuration at startup. The service must refuse to start when this throws.
 * Error messages name the variable but never echo its value (values may be secrets).
 */
export function parseConfig<S extends ZodTypeAny>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data as z.infer<S>;
}

/** Reusable field helpers. */
export const env = {
  port: () => z.coerce.number().int().min(1).max(65535),
  positiveInt: (fallback: number) => z.coerce.number().int().positive().default(fallback),
  nonNegativeInt: (fallback: number) => z.coerce.number().int().min(0).default(fallback),
  url: () => z.string().url(),
  secret: () => z.string().min(8, 'must be at least 8 characters'),
  identifier: () => z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase SQL identifier'),
  csv: () =>
    z.string().transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  bool: (fallback: boolean) =>
    z
      .enum(['true', 'false'])
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true'),
  nodeEnv: () => z.enum(['development', 'test', 'production']).default('development'),
  logLevel: () => z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
};
