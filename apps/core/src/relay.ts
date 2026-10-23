import {
  ClientCredentialsTokenProvider,
  createLogger,
  createPool,
  HttpDeliveryTransport,
  loadDotEnvIfPresent,
  OutboxRelay,
  OutboxStore,
  SubscriptionTable,
} from '@dv/shared';
import { resolve } from 'node:path';
import { loadCoreRelayConfig } from './config/config';

/** core's outbox relay: a separate PM2 process that delivers core.outbox_event rows to subscribers. */
async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadCoreRelayConfig();
  const logger = createLogger({
    service: 'core-relay',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });
  const pool = createPool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.CORE_DB_USER,
    password: config.CORE_DB_PASSWORD,
    applicationName: 'dv-core-relay',
    maxConnections: 5,
  });
  pool.on('error', (error) =>
    logger.error({ operation: 'db_pool', error_message: error.message }, 'idle client error'),
  );
  const subscriptions = SubscriptionTable.load(
    resolve(process.cwd(), config.CORE_SUBSCRIPTIONS_FILE),
  );
  const tokens = new ClientCredentialsTokenProvider({
    tokenUrl: config.KEYCLOAK_TOKEN_URL,
    clientId: config.CORE_CLIENT_ID,
    clientSecret: config.CORE_CLIENT_SECRET,
    logger,
  });
  const relay = new OutboxRelay(
    new OutboxStore(pool, 'core'),
    subscriptions,
    new HttpDeliveryTransport(tokens, config.RELAY_DELIVERY_TIMEOUT_MS),
    {
      pollIntervalMs: config.RELAY_POLL_INTERVAL_MS,
      batchSize: config.RELAY_BATCH_SIZE,
      maxInFlight: config.RELAY_MAX_IN_FLIGHT,
      maxInFlightPerSubscriber: config.RELAY_MAX_IN_FLIGHT_PER_SUBSCRIBER,
      leaseMs: config.RELAY_LEASE_MS,
      backoff: {
        baseMs: config.RELAY_BACKOFF_BASE_MS,
        maxMs: config.RELAY_BACKOFF_MAX_MS,
        maxAttempts: config.RELAY_MAX_ATTEMPTS,
      },
    },
    logger,
  );
  relay.start();

  const shutdown = async (signal: string) => {
    logger.info({ operation: 'shutdown', signal }, 'relay shutting down');
    await relay.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'core-relay', msg: 'startup failed', error_message: (error as Error).message })}\n`,
  );
  process.exit(1);
});
