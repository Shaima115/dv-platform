import 'reflect-metadata';
import {
  ClientCredentialsTokenProvider,
  createLogger,
  createPool,
  JwtVerifier,
  loadDotEnvIfPresent,
  ServiceHttpClient,
  startHttpService,
} from '@dv/shared';
import { HttpVerificationGateway } from './adapters/http/verification-gateway.adapter';
import { mapCoreError } from './api/error-mapping';
import { CoreModule } from './app.module';
import { loadCoreConfig } from './config/config';

async function bootstrap(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadCoreConfig();
  const logger = createLogger({
    service: 'core',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });

  const pool = createPool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.CORE_DB_USER,
    password: config.CORE_DB_PASSWORD,
    applicationName: 'dv-core',
  });
  pool.on('error', (error) =>
    logger.error({ operation: 'db_pool', error_message: error.message }, 'idle client error'),
  );

  const verifier = new JwtVerifier({
    issuer: config.KEYCLOAK_ISSUER,
    jwksUri: config.KEYCLOAK_JWKS_URI,
    audience: config.CORE_CLIENT_ID,
    userClientIds: config.KEYCLOAK_USER_CLIENT_IDS,
    serviceClientIds: config.KEYCLOAK_SERVICE_CLIENT_IDS,
    clockToleranceSeconds: config.JWT_CLOCK_TOLERANCE_S,
    jwksCacheMaxAgeMs: config.JWKS_CACHE_MAX_AGE_MS,
  });
  const tokens = new ClientCredentialsTokenProvider({
    tokenUrl: config.KEYCLOAK_TOKEN_URL,
    clientId: config.CORE_CLIENT_ID,
    clientSecret: config.CORE_CLIENT_SECRET,
    logger,
  });
  const http = new ServiceHttpClient(
    config.VERIFICATION_INTERNAL_URL,
    tokens,
    {
      attemptTimeoutMs: config.VERIFICATION_CALL_TIMEOUT_MS,
      maxRetries: config.VERIFICATION_CALL_MAX_RETRIES,
      backoffBaseMs: config.VERIFICATION_CALL_BACKOFF_BASE_MS,
      overallDeadlineMs: config.VERIFICATION_CALL_DEADLINE_MS,
    },
    logger,
  );
  const gateway = new HttpVerificationGateway(
    http,
    {
      errorThresholdPercentage: config.BREAKER_ERROR_THRESHOLD_PCT,
      volumeThreshold: config.BREAKER_VOLUME_THRESHOLD,
      rollingCountTimeout: config.BREAKER_ROLLING_WINDOW_MS,
      resetTimeout: config.BREAKER_RESET_TIMEOUT_MS,
    },
    logger,
  );

  await startHttpService(
    CoreModule.forRoot({
      pool,
      logger,
      verifier,
      gateway,
      submissionClaimMs: config.VERIFICATION_SUBMISSION_CLAIM_MS,
    }),
    {
      host: config.CORE_HOST,
      port: config.CORE_PORT,
      logger,
      mapError: mapCoreError,
      onShutdown: () => pool.end(),
    },
  );
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet (invalid config), so write a single JSON line to stderr and exit.
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'core', msg: 'startup failed', error_message: (error as Error).message })}\n`,
  );
  process.exit(1);
});
