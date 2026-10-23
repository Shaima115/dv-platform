import { env, parseConfig } from '@dv/shared';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: env.nodeEnv(),
  LOG_LEVEL: env.logLevel(),
  CORE_HOST: z.string().default('127.0.0.1'),
  CORE_PORT: env.port(),

  PG_HOST: z.string().min(1),
  PG_PORT: env.port().default(5432),
  PG_DATABASE: z.string().min(1),
  CORE_DB_USER: z.string().min(1),
  CORE_DB_PASSWORD: env.secret(),

  KEYCLOAK_ISSUER: env.url(),
  KEYCLOAK_JWKS_URI: env.url(),
  KEYCLOAK_TOKEN_URL: env.url(),
  KEYCLOAK_USER_CLIENT_IDS: env.csv(),
  KEYCLOAK_SERVICE_CLIENT_IDS: env.csv(),
  JWT_CLOCK_TOLERANCE_S: env.nonNegativeInt(0),
  JWKS_CACHE_MAX_AGE_MS: env.positiveInt(600_000),
  CORE_CLIENT_ID: z.string().min(1),
  CORE_CLIENT_SECRET: env.secret(),

  VERIFICATION_INTERNAL_URL: env
    .url()
    .refine((url) => new URL(url).hostname.endsWith('.internal'), {
      message: 'must point at the Nginx internal listener (*.internal), never a port',
    }),
  VERIFICATION_CALL_TIMEOUT_MS: env.positiveInt(2000),
  VERIFICATION_CALL_MAX_RETRIES: env.nonNegativeInt(2).pipe(z.number().max(5)),
  VERIFICATION_CALL_BACKOFF_BASE_MS: env.positiveInt(150),
  VERIFICATION_CALL_DEADLINE_MS: env.positiveInt(4500),
  VERIFICATION_SUBMISSION_CLAIM_MS: env.positiveInt(10_000),

  BREAKER_ERROR_THRESHOLD_PCT: env.positiveInt(50).pipe(z.number().max(100)),
  BREAKER_VOLUME_THRESHOLD: env.positiveInt(3),
  BREAKER_ROLLING_WINDOW_MS: env.positiveInt(30_000),
  BREAKER_RESET_TIMEOUT_MS: env.positiveInt(15_000),
});

export type CoreConfig = z.infer<typeof schema>;

export const loadCoreConfig = (source: NodeJS.ProcessEnv = process.env): CoreConfig =>
  parseConfig(schema, source);

const relaySchema = z
  .object({
    NODE_ENV: env.nodeEnv(),
    LOG_LEVEL: env.logLevel(),
    PG_HOST: z.string().min(1),
    PG_PORT: env.port().default(5432),
    PG_DATABASE: z.string().min(1),
    CORE_DB_USER: z.string().min(1),
    CORE_DB_PASSWORD: env.secret(),
    KEYCLOAK_TOKEN_URL: env.url(),
    CORE_CLIENT_ID: z.string().min(1),
    CORE_CLIENT_SECRET: env.secret(),
    CORE_SUBSCRIPTIONS_FILE: z.string().min(1),
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

export type CoreRelayConfig = z.infer<typeof relaySchema>;
export const loadCoreRelayConfig = (source: NodeJS.ProcessEnv = process.env): CoreRelayConfig =>
  parseConfig(relaySchema, source);
