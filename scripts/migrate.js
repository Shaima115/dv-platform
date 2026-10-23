#!/usr/bin/env node
/**
 * Versioned SQL migration runner (no schema auto-sync anywhere).
 *
 * Applies database/migrations/<service>/*.sql in filename order as the dv_migrator role.
 * Each file runs in its own transaction together with its bookkeeping row, so a failed file leaves
 * nothing behind. A changed checksum on an already-applied file is an error.
 *
 *   node scripts/migrate.js                 # all services
 *   node scripts/migrate.js --service core  # one service
 *   node scripts/migrate.js --status        # list applied / pending
 */
const { createHash } = require('node:crypto');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { Client } = require('pg');

const ROOT = resolve(__dirname, '..');
const SERVICES = ['core', 'verification', 'notification'];

function loadEnv() {
  const path = process.env.DOTENV_PATH ?? join(ROOT, '.env');
  if (!existsSync(path)) return;
  const before = { ...process.env };
  process.loadEnvFile(path);
  Object.assign(process.env, before);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

function parseArgs(argv) {
  const args = { services: SERVICES, status: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--service') {
      const service = argv[(i += 1)];
      if (!SERVICES.includes(service)) {
        console.error(`Unknown service ${service}. Expected one of ${SERVICES.join(', ')}`);
        process.exit(2);
      }
      args.services = [service];
    } else if (argv[i] === '--status') {
      args.status = true;
    }
  }
  return args;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const client = new Client({
    host: required('PG_HOST'),
    port: Number(process.env.PG_PORT ?? 5432),
    database: required('PG_DATABASE'),
    user: required('MIGRATOR_DB_USER'),
    password: required('MIGRATOR_DB_PASSWORD'),
    application_name: 'dv-migrate',
  });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS dv_migrations`);
    await client.query(`CREATE TABLE IF NOT EXISTS dv_migrations.applied (
        service     text NOT NULL,
        filename    text NOT NULL,
        checksum    char(64) NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (service, filename))`);

    for (const service of args.services) {
      const dir = join(ROOT, 'database', 'migrations', service);
      const files = readdirSync(dir)
        .filter((file) => file.endsWith('.sql'))
        .sort();
      const { rows } = await client.query(
        'SELECT filename, checksum FROM dv_migrations.applied WHERE service = $1',
        [service],
      );
      const applied = new Map(rows.map((row) => [row.filename, row.checksum]));

      for (const file of files) {
        const sql = readFileSync(join(dir, file), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        if (applied.has(file)) {
          if (applied.get(file) !== checksum) {
            throw new Error(
              `${service}/${file} changed after it was applied; add a new migration instead`,
            );
          }
          if (args.status) console.log(`  applied  ${service}/${file}`);
          continue;
        }
        if (args.status) {
          console.log(`  pending  ${service}/${file}`);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO dv_migrations.applied (service, filename, checksum) VALUES ($1, $2, $3)',
            [service, file, checksum],
          );
          await client.query('COMMIT');
          console.log(`  applied  ${service}/${file}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`${service}/${file} failed: ${error.message}`);
        }
      }
    }
    console.log('migrations complete');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
