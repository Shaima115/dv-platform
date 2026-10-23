import type { Pool } from 'pg';
import { sqlIdentifier } from '../database/database';
import type { EventEnvelope } from '../events/envelope';
import type { SubscriptionTable } from './subscriptions';

export interface ClaimedDelivery {
  id: string;
  eventId: string;
  subscriber: string;
  targetUrl: string;
  /** Attempt number of this claim (1-based; already incremented). */
  attempt: number;
  envelope: EventEnvelope;
}

/** Caps how many deliveries one subscriber may have in flight in this worker. */
export interface PerSubscriberLimit {
  limit: number;
  /** Deliveries this worker already has in flight, by subscriber name. */
  busy: ReadonlyMap<string, number>;
}

/**
 * All relay SQL. Every method is a single short statement or a short transaction; no lock is ever held
 * while the relay talks to the network.
 */
export class OutboxStore {
  private readonly events: string;
  private readonly deliveries: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    const safe = sqlIdentifier(schema);
    this.events = `${safe}.outbox_event`;
    this.deliveries = `${safe}.outbox_delivery`;
  }

  /**
   * Fan-out: turns new outbox events into one delivery row per subscriber. Events are locked with
   * SKIP LOCKED so two relay instances never fan out the same event; the unique (event_id, subscriber)
   * constraint makes a repeat harmless anyway.
   */
  async fanOut(subscriptions: SubscriptionTable, batchSize: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ event_id: string; event_type: string }>(
        `SELECT event_id, event_type FROM ${this.events}
          WHERE fanned_out_at IS NULL
          ORDER BY created_at, event_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      for (const row of rows) {
        for (const subscriber of subscriptions.subscribersFor(row.event_type)) {
          await client.query(
            `INSERT INTO ${this.deliveries} (event_id, subscriber, target_url)
             VALUES ($1, $2, $3)
             ON CONFLICT (event_id, subscriber) DO NOTHING`,
            [row.event_id, subscriber.name, subscriber.url],
          );
        }
      }
      if (rows.length > 0) {
        await client.query(
          `UPDATE ${this.events} SET fanned_out_at = now() WHERE event_id = ANY($1::uuid[])`,
          [rows.map((row) => row.event_id)],
        );
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Claims due deliveries in one statement: pending rows whose retry time has come, plus in-flight rows
   * whose lease expired (a relay crashed mid-delivery). FOR UPDATE SKIP LOCKED lets concurrent relays
   * claim disjoint rows. The claim commits immediately, so no lock is held during the HTTP call; the
   * lease stops other workers from re-claiming while this one delivers.
   */
  async claim(
    limit: number,
    leaseMs: number,
    maxAttempts: number,
    perSubscriber?: PerSubscriberLimit,
  ): Promise<ClaimedDelivery[]> {
    if (limit <= 0) return [];
    // Without a per-subscriber limit every subscriber may take all of `limit`.
    const subscriberLimit = perSubscriber?.limit ?? limit;
    const busy = perSubscriber ? [...perSubscriber.busy.entries()] : [];
    const { rows } = await this.pool.query<{
      id: string;
      event_id: string;
      subscriber: string;
      target_url: string;
      attempts: number;
      payload: EventEnvelope;
    }>(
      // `ranked` numbers each subscriber's due rows; a subscriber only gets the slots it has left
      // (its limit minus what this worker already has in flight for it), so a slow subscriber can
      // never take the capacity other subscribers need. The window function cannot share a SELECT
      // with FOR UPDATE, so the lock is taken in `due`.
      `WITH busy AS (
         SELECT * FROM unnest($4::text[], $5::int[]) AS b(subscriber, in_flight)
       ), ranked AS (
         SELECT id, next_attempt_at,
                row_number() OVER (PARTITION BY subscriber ORDER BY next_attempt_at, id) AS rn,
                $6::int - COALESCE((SELECT in_flight FROM busy WHERE busy.subscriber = d.subscriber), 0) AS free
           FROM ${this.deliveries} d
          WHERE attempts < $3
            AND ((status = 'pending' AND next_attempt_at <= now())
              OR (status = 'in_flight' AND lease_until < now()))
       ), due AS (
         SELECT d.id FROM ${this.deliveries} d
           JOIN ranked r ON r.id = d.id
          WHERE r.rn <= r.free
            -- Repeated on the locked row so a concurrent claim that committed meanwhile is re-checked.
            AND d.attempts < $3
            AND ((d.status = 'pending' AND d.next_attempt_at <= now())
              OR (d.status = 'in_flight' AND d.lease_until < now()))
          ORDER BY r.next_attempt_at, r.id
          LIMIT $1
          FOR UPDATE OF d SKIP LOCKED
       ), claimed AS (
         UPDATE ${this.deliveries} d
            SET status = 'in_flight',
                attempts = d.attempts + 1,
                lease_until = now() + ($2::int * interval '1 millisecond'),
                updated_at = now()
           FROM due
          WHERE d.id = due.id
          RETURNING d.id, d.event_id, d.subscriber, d.target_url, d.attempts
       )
       SELECT c.id::text, c.event_id::text, c.subscriber, c.target_url, c.attempts, e.payload
         FROM claimed c JOIN ${this.events} e ON e.event_id = c.event_id`,
      [
        limit,
        leaseMs,
        maxAttempts,
        busy.map(([subscriber]) => subscriber),
        busy.map(([, inFlight]) => inFlight),
        subscriberLimit,
      ],
    );
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      subscriber: row.subscriber,
      targetUrl: row.target_url,
      attempt: row.attempts,
      envelope: row.payload,
    }));
  }

  /** Marks delivered only if this worker still owns the claim (same attempt, still in flight). */
  async markDelivered(delivery: ClaimedDelivery, statusCode: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.deliveries}
          SET status = 'delivered', delivered_at = now(), last_status_code = $3, lease_until = NULL,
              last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'in_flight' AND attempts = $2`,
      [delivery.id, delivery.attempt, statusCode],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async scheduleRetry(
    delivery: ClaimedDelivery,
    delayMs: number,
    error: string,
    statusCode?: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.deliveries}
          SET status = 'pending', next_attempt_at = now() + ($3::int * interval '1 millisecond'),
              last_error = $4, last_status_code = $5, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'in_flight' AND attempts = $2`,
      [delivery.id, delivery.attempt, delayMs, error.slice(0, 500), statusCode ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markDead(delivery: ClaimedDelivery, error: string, statusCode?: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.deliveries}
          SET status = 'dead', dead_at = now(), last_error = $3, last_status_code = $4,
              lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'in_flight' AND attempts = $2`,
      [delivery.id, delivery.attempt, error.slice(0, 500), statusCode ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** In-flight rows that ran out of attempts while their worker crashed: mark them dead. */
  async buryAbandoned(
    maxAttempts: number,
  ): Promise<Array<{ id: string; event_id: string; subscriber: string }>> {
    const { rows } = await this.pool.query<{ id: string; event_id: string; subscriber: string }>(
      `UPDATE ${this.deliveries}
          SET status = 'dead', dead_at = now(), last_error = COALESCE(last_error, 'lease expired on final attempt'),
              lease_until = NULL, updated_at = now()
        WHERE status = 'in_flight' AND lease_until < now() AND attempts >= $1
        RETURNING id::text, event_id::text, subscriber`,
      [maxAttempts],
    );
    return rows;
  }

  /** Re-queues dead deliveries (all, or selected ids) with a fresh attempt budget. */
  async requeueDead(ids?: readonly string[]): Promise<number> {
    const filter = ids && ids.length > 0 ? 'AND id = ANY($1::bigint[])' : '';
    const result = await this.pool.query(
      `UPDATE ${this.deliveries}
          SET status = 'pending', attempts = 0, next_attempt_at = now(), dead_at = NULL, updated_at = now()
        WHERE status = 'dead' ${filter}`,
      ids && ids.length > 0 ? [ids] : [],
    );
    return result.rowCount ?? 0;
  }
}
