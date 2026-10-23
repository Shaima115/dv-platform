import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { Client, type Pool } from 'pg';
import { createLogger, createPool } from '@dv/shared';

const ROOT = resolve(__dirname, '../../..');

/** Loads .env (development) so tests use the same roles and passwords as the services. */
export function loadEnv(): void {
  const path = process.env.DOTENV_PATH ?? resolve(ROOT, '.env');
  if (existsSync(path)) {
    // Assign explicitly: Jest gives each test file its own process.env copy.
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
      if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Integration tests need ${name} (see .env.example, "Integration tests only").`);
  }
  return value;
}

export const silentLogger = () =>
  createLogger({
    service: 'test',
    environment: 'test',
    level: 'fatal',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });

export interface TestDatabase {
  name: string;
  core: Pool;
  verification: Pool;
  notification: Pool;
  /** Pool authenticated as an arbitrary runtime role (role-isolation tests). */
  as(role: 'core' | 'verification' | 'notification'): Pool;
  drop(): Promise<void>;
}

/**
 * Creates a throwaway database owned by dv_migrator, applies every real migration with the real
 * migration runner, and returns pools for each service's runtime role. Roles come from
 * scripts/provision-db.sh (cluster-wide); run `npm run db:provision` once beforehand.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  loadEnv();
  const name = `dv_it_${process.pid}_${Date.now().toString(36)}`;
  const host = required('PG_HOST');
  const port = Number(process.env.PG_PORT ?? 5432);
  const admin = new Client({
    host,
    port,
    user: required('PG_SUPERUSER'),
    password: required('PG_SUPERUSER_PASSWORD'),
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER dv_migrator`);
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${name} TO dv_core, dv_verification, dv_notification`,
    );
  } finally {
    await admin.end();
  }
  const scoped = new Client({
    host,
    port,
    user: required('PG_SUPERUSER'),
    password: required('PG_SUPERUSER_PASSWORD'),
    database: name,
  });
  await scoped.connect();
  await scoped.query(
    'REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO dv_migrator',
  );
  await scoped.end();

  execFileSync('node', [resolve(ROOT, 'scripts/migrate.js')], {
    env: { ...process.env, PG_DATABASE: name },
    stdio: 'pipe',
  });

  const pools: Pool[] = [];
  const pool = (role: 'core' | 'verification' | 'notification') => {
    const upper = role.toUpperCase();
    const created = createPool({
      host,
      port,
      database: name,
      user: required(`${upper}_DB_USER`),
      password: required(`${upper}_DB_PASSWORD`),
      applicationName: `it-${role}`,
      maxConnections: 20,
    });
    // DROP DATABASE … WITH (FORCE) can terminate a connection that pool.end() is still closing.
    created.on('error', () => undefined);
    pools.push(created);
    return created;
  };

  return {
    name,
    core: pool('core'),
    verification: pool('verification'),
    notification: pool('notification'),
    as: pool,
    async drop() {
      await Promise.all(pools.map((p) => p.end()));
      const cleanup = new Client({
        host,
        port,
        user: required('PG_SUPERUSER'),
        password: required('PG_SUPERUSER_PASSWORD'),
        database: 'postgres',
      });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
