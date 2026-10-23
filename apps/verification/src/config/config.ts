import { env, parseConfig } from '@dv/shared';
import { z } from 'zod';

const base = {
  NODE_ENV: env.nodeEnv(),
  LOG_LEVEL: env.logLevel(),
  PG_HOST: z.string().min(1),
  PG_PORT: env.port().default(5432),
  PG_DATABASE: z.string().min(1),
  VERIFICATION_DB_USER: z.string().min(1),
  VERIFICATION_DB_PASSWORD: env.secret(),
  KEYCLOAK_TOKEN_URL: env.url(),
  VERIFICATION_CLIENT_ID: z.string().min(1),
  VERIFICATION_CLIENT_SECRET: env.secret(),
};

const apiSchema = z.object({
  ...base,
  VERIFICATION_HOST: z.string().default('127.0.0.1'),
  VERIFICATION_PORT: env.port(),
  KEYCLOAK_ISSUER: env.url(),
  KEYCLOAK_JWKS_URI: env.url(),
  KEYCLOAK_USER_CLIENT_IDS: env.csv(),
  KEYCLOAK_SERVICE_CLIENT_IDS: env.csv(),
  JWT_CLOCK_TOLERANCE_S: env.nonNegativeInt(0),
  JWKS_CACHE_MAX_AGE_MS: env.positiveInt(600_000),
});

const relaySchema = z
  .object({
    ...base,
    VERIFICATION_SUBSCRIPTIONS_FILE: z.string().min(1),
    RELAY_POLL_INTERVAL_MS: env.positiveInt(250),
    RELAY_BATCH_SIZE: env.positiveInt(50),
    RELAY_MAX_IN_FLIGHT: env.positiveInt(20),
    RELAY_MAX_IN_FLIGHT_PER_SUBSCRIBER: env.positiveInt(5),
    RELAY_LEASE_MS: env.positiveInt(15_000),
    RELAY_DELIVERY_TIMEOUT_MS: env.positiveInt(5_000),
    RELAY_BACKOFF_BASE_MS: env.positiveInt(1_000),
    RELAY_BACKOFF_MAX_MS: env.positiveInt(60_000),
    RELAY_MAX_ATTEMPTS: env.positiveInt(5),
  })
  .refine((c) => c.RELAY_LEASE_MS > c.RELAY_DELIVERY_TIMEOUT_MS, {
    message: 'RELAY_LEASE_MS must exceed RELAY_DELIVERY_TIMEOUT_MS',
  })
  .refine((c) => c.RELAY_MAX_IN_FLIGHT_PER_SUBSCRIBER <= c.RELAY_MAX_IN_FLIGHT, {
    message: 'RELAY_MAX_IN_FLIGHT_PER_SUBSCRIBER must not exceed RELAY_MAX_IN_FLIGHT',
    path: ['RELAY_MAX_IN_FLIGHT_PER_SUBSCRIBER'],
  });

export type VerificationConfig = z.infer<typeof apiSchema>;
export type VerificationRelayConfig = z.infer<typeof relaySchema>;
export const loadVerificationConfig = (source = process.env): VerificationConfig =>
  parseConfig(apiSchema, source);
export const loadVerificationRelayConfig = (source = process.env): VerificationRelayConfig =>
  parseConfig(relaySchema, source);
