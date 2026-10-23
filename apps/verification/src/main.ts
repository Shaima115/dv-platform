import 'reflect-metadata';
import {
  createLogger,
  createPool,
  JwtVerifier,
  loadDotEnvIfPresent,
  startHttpService,
} from '@dv/shared';
import { mapVerificationError } from './api/error-mapping';
import { VerificationModule } from './app.module';
import { loadVerificationConfig } from './config/config';

async function bootstrap(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadVerificationConfig();
  const logger = createLogger({
    service: 'verification',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });
  const pool = createPool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.VERIFICATION_DB_USER,
    password: config.VERIFICATION_DB_PASSWORD,
    applicationName: 'dv-verification',
  });
  pool.on('error', (error) =>
    logger.error({ operation: 'db_pool', error_message: error.message }, 'idle client error'),
  );
  const verifier = new JwtVerifier({
    issuer: config.KEYCLOAK_ISSUER,
    jwksUri: config.KEYCLOAK_JWKS_URI,
    audience: config.VERIFICATION_CLIENT_ID,
    userClientIds: config.KEYCLOAK_USER_CLIENT_IDS,
    serviceClientIds: config.KEYCLOAK_SERVICE_CLIENT_IDS,
    clockToleranceSeconds: config.JWT_CLOCK_TOLERANCE_S,
    jwksCacheMaxAgeMs: config.JWKS_CACHE_MAX_AGE_MS,
  });
  await startHttpService(VerificationModule.forRoot({ pool, verifier }), {
    host: config.VERIFICATION_HOST,
    port: config.VERIFICATION_PORT,
    logger,
    mapError: mapVerificationError,
    onShutdown: () => pool.end(),
  });
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'verification', msg: 'startup failed', error_message: (error as Error).message })}\n`,
  );
  process.exit(1);
});
