import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export interface DatabaseOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections?: number;
  applicationName: string;
  statementTimeoutMs?: number;
}

/** Minimal query surface shared by a pool and a transaction. Always use parameters, never string concat. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** A handle valid only inside one transaction. Passing it around makes the boundary explicit. */
export interface Transaction extends Queryable {
  readonly isTransaction: true;
}

/** Runs units of work inside a database transaction. Implemented over pg; mockable in unit tests. */
export interface TransactionRunner {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}

export function createPool(options: DatabaseOptions): Pool {
  return new Pool({
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    password: options.password,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

class PgTransaction implements Transaction {
  readonly isTransaction = true as const;
  constructor(private readonly client: PoolClient) {}
  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ) {
    const result = await this.client.query<R>(text, values as unknown[] | undefined);
    return { rows: result.rows, rowCount: result.rowCount };
  }
}

/**
 * BEGIN … COMMIT around `work`; ROLLBACK on any error, which is re-thrown (never swallowed).
 * The default isolation is READ COMMITTED; correctness relies on row locks and unique constraints.
 */
export class PgTransactionRunner implements TransactionRunner {
  constructor(private readonly pool: Pool) {}

  async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discardConnection = false;
    try {
      await client.query('BEGIN');
      const result = await work(new PgTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is the useful one; a connection that cannot roll back is discarded.
        discardConnection = true;
      }
      throw error;
    } finally {
      client.release(discardConnection);
    }
  }
}

/** Readiness probe: the database answers a trivial query within the timeout. */
export async function checkDatabase(pool: Pool, timeoutMs = 2_000): Promise<boolean> {
  const timer = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), timeoutMs).unref(),
  );
  const probe = pool
    .query('SELECT 1')
    .then(() => true)
    .catch(() => false);
  return Promise.race([probe, timer]);
}

const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** Validates a schema/table name before it is interpolated into SQL (identifiers cannot be parameters). */
export function sqlIdentifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return name;
}
