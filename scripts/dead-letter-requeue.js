#!/usr/bin/env node
/**
 * Lists or re-queues dead outbox deliveries for one producer, using that service's own database role.
 * Re-queued rows get a fresh attempt budget and are picked up by the running relay.
 *
 *   node scripts/dead-letter-requeue.js --service core --list
 *   node scripts/dead-letter-requeue.js --service core --id 42 --id 43
 *   node scripts/dead-letter-requeue.js --service verification --all
 *
 * Fix the cause first (bad subscriber, fault) — otherwise the delivery simply dies again.
 */
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const { createPool, OutboxStore } = require(join(ROOT, 'packages/shared/dist'));

const PRODUCERS = {
  core: { schema: 'core', user: 'CORE_DB_USER', password: 'CORE_DB_PASSWORD' },
  verification: {
    schema: 'compliance',
    user: 'VERIFICATION_DB_USER',
    password: 'VERIFICATION_DB_PASSWORD',
  },
};

function parseArgs(argv) {
  const args = { service: undefined, ids: [], all: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--service') args.service = argv[(i += 1)];
    else if (arg === '--id') args.ids.push(argv[(i += 1)]);
    else if (arg === '--all') args.all = true;
    else if (arg === '--list') args.list = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!PRODUCERS[args.service])
    throw new Error(`--service must be one of ${Object.keys(PRODUCERS).join(', ')}`);
  if (!args.list && !args.all && args.ids.length === 0)
    throw new Error('pass --list, --all or one or more --id');
  if (args.ids.some((id) => !/^\d+$/.test(id))) throw new Error('--id takes numeric delivery ids');
  return args;
}

async function main() {
  const envPath = process.env.DOTENV_PATH ?? join(ROOT, '.env');
  if (existsSync(envPath)) {
    const before = { ...process.env };
    process.loadEnvFile(envPath);
    Object.assign(process.env, before);
  }
  const args = parseArgs(process.argv.slice(2));
  const producer = PRODUCERS[args.service];
  const pool = createPool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT ?? 5432),
    database: process.env.PG_DATABASE,
    user: process.env[producer.user],
    password: process.env[producer.password],
    applicationName: 'dv-dead-letter-requeue',
    maxConnections: 1,
  });
  try {
    if (args.list) {
      const { rows } = await pool.query(
        `SELECT d.id, d.event_id, e.event_type, d.subscriber, d.attempts, d.last_status_code, d.last_error, d.dead_at
           FROM ${producer.schema}.outbox_delivery d JOIN ${producer.schema}.outbox_event e USING (event_id)
          WHERE d.status = 'dead' ORDER BY d.dead_at`,
      );
      console.table(rows);
      return;
    }
    const count = await new OutboxStore(pool, producer.schema).requeueDead(
      args.all ? undefined : args.ids,
    );
    console.log(
      JSON.stringify({ operation: 'dead_letter_requeue', service: args.service, requeued: count }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
