import type { Logger } from 'pino';
import { sqlIdentifier, type Transaction, type TransactionRunner } from '../database/database';
import type { EventEnvelope } from '../events/envelope';
import type { EventHandler, EventHandlingResult } from '../events/ports';

export type InboxResult =
  { status: 'processed'; result: EventHandlingResult } | { status: 'duplicate' };

/**
 * Transactional inbox. In ONE transaction it inserts (consumer, event_id) into inbox_processed and runs
 * the handler. The primary key makes duplicates — including concurrent ones — block on the first
 * insert and then see a conflict, so side effects happen once. If the handler throws, the inbox row
 * rolls back too and the producer's relay retries. The caller answers 2xx only after this resolves,
 * i.e. after COMMIT.
 */
export class TransactionalInbox {
  private readonly table: string;

  constructor(
    schema: string,
    private readonly consumer: string,
    private readonly transactions: TransactionRunner,
    private readonly logger: Logger,
  ) {
    this.table = `${sqlIdentifier(schema)}.inbox_processed`;
  }

  async process<T>(event: EventEnvelope<T>, handler: EventHandler<T>): Promise<InboxResult> {
    const outcome = await this.transactions.run(async (tx: Transaction) => {
      const inserted = await tx.query(
        `INSERT INTO ${this.table} (consumer, event_id, event_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (consumer, event_id) DO NOTHING
         RETURNING event_id`,
        [this.consumer, event.event_id, event.event_type],
      );
      if (inserted.rowCount === 0) {
        return { status: 'duplicate' } as const;
      }
      const result = await handler.handle(tx, event);
      if (result.outcome === 'ignored') {
        await tx.query(
          `UPDATE ${this.table} SET outcome = 'ignored', note = $3 WHERE consumer = $1 AND event_id = $2`,
          [this.consumer, event.event_id, result.reason.slice(0, 200)],
        );
      }
      return { status: 'processed', result } as const;
    });

    const logFields = {
      operation: 'inbox',
      event_id: event.event_id,
      event_type: event.event_type,
    };
    if (outcome.status === 'duplicate') {
      this.logger.info(logFields, 'duplicate event acknowledged without side effects');
    } else if (outcome.result.outcome === 'ignored') {
      this.logger.warn({ ...logFields, reason: outcome.result.reason }, 'event ignored');
    } else {
      this.logger.info(logFields, 'event processed');
    }
    return outcome;
  }
}
