import { sqlIdentifier, type Transaction } from '../database/database';
import { assertPublishable } from '../events/contracts';
import type { EventEnvelope } from '../events/envelope';
import type { EventPublisher } from '../events/ports';

/**
 * EventPublisher backed by the transactional outbox. `publish` only INSERTs a row using the caller's
 * transaction, so the event commits or rolls back together with the business change.
 * It performs no network I/O; the relay process delivers the row later.
 */
export class OutboxEventPublisher implements EventPublisher {
  private readonly table: string;

  constructor(schema: string) {
    this.table = `${sqlIdentifier(schema)}.outbox_event`;
  }

  async publish(tx: Transaction, envelope: EventEnvelope): Promise<void> {
    if (!tx.isTransaction) {
      throw new Error('Events must be published inside the business transaction.');
    }
    assertPublishable(envelope);
    await tx.query(
      `INSERT INTO ${this.table}
         (event_id, event_type, schema_version, aggregate_id, request_id, traceparent, country, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        envelope.event_id,
        envelope.event_type,
        envelope.schema_version,
        envelope.aggregate_id,
        envelope.request_id,
        envelope.traceparent,
        envelope.country,
        JSON.stringify(envelope),
        envelope.occurred_at,
      ],
    );
  }
}
