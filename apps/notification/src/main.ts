import 'reflect-metadata';
import {
  createLogger,
  createPool,
  JwtVerifier,
  loadDotEnvIfPresent,
  startHttpService,
} from '@dv/shared';
import { NotificationModule } from './app.module';
import { loadNotificationConfig } from './config/config';

async function bootstrap(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadNotificationConfig();
  const logger = createLogger({
    service: 'notification',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });
  const pool = createPool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.NOTIFICATION_DB_USER,
    password: config.NOTIFICATION_DB_PASSWORD,
    applicationName: 'dv-notification',
  });
  pool.on('error', (error) =>
    logger.error({ operation: 'db_pool', error_message: error.message }, 'idle client error'),
  );
  const verifier = new JwtVerifier({
    issuer: config.KEYCLOAK_ISSUER,
    jwksUri: config.KEYCLOAK_JWKS_URI,
    audience: config.NOTIFICATION_CLIENT_ID,
    userClientIds: config.KEYCLOAK_USER_CLIENT_IDS,
    serviceClientIds: config.KEYCLOAK_SERVICE_CLIENT_IDS,
    clockToleranceSeconds: config.JWT_CLOCK_TOLERANCE_S,
    jwksCacheMaxAgeMs: config.JWKS_CACHE_MAX_AGE_MS,
  });
  if (config.NOTIFICATION_FAULT_FILE) {
    logger.warn(
      { operation: 'startup', fault_file: config.NOTIFICATION_FAULT_FILE },
      'development fault injection is enabled',
    );
  }
  await startHttpService(
    NotificationModule.forRoot({
      pool,
      verifier,
      logger,
      faultFile: config.NOTIFICATION_FAULT_FILE,
    }),
    {
      host: config.NOTIFICATION_HOST,
      port: config.NOTIFICATION_PORT,
      logger,
      onShutdown: () => pool.end(),
    },
  );
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'notification', msg: 'startup failed', error_message: (error as Error).message })}\n`,
  );
  process.exit(1);
});
