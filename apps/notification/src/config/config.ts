import { env, parseConfig } from '@dv/shared';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: env.nodeEnv(),
    LOG_LEVEL: env.logLevel(),
    NOTIFICATION_HOST: z.string().default('127.0.0.1'),
    NOTIFICATION_PORT: env.port(),
    PG_HOST: z.string().min(1),
    PG_PORT: env.port().default(5432),
    PG_DATABASE: z.string().min(1),
    NOTIFICATION_DB_USER: z.string().min(1),
    NOTIFICATION_DB_PASSWORD: env.secret(),
    KEYCLOAK_ISSUER: env.url(),
    KEYCLOAK_JWKS_URI: env.url(),
    KEYCLOAK_USER_CLIENT_IDS: env.csv(),
    KEYCLOAK_SERVICE_CLIENT_IDS: env.csv(),
    JWT_CLOCK_TOLERANCE_S: env.nonNegativeInt(0),
    JWKS_CACHE_MAX_AGE_MS: env.positiveInt(600_000),
    NOTIFICATION_CLIENT_ID: z.string().min(1),
    NOTIFICATION_FAULT_FILE: z
      .string()
      .optional()
      .transform((value) => (value ? value : undefined)),
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.NOTIFICATION_FAULT_FILE), {
    message: 'NOTIFICATION_FAULT_FILE must not be set in production',
    path: ['NOTIFICATION_FAULT_FILE'],
  });

export type NotificationConfig = z.infer<typeof schema>;
export const loadNotificationConfig = (source = process.env): NotificationConfig =>
  parseConfig(schema, source);
