import type { Logger } from 'pino';
import { describeError } from '../logging/logger';
import { createContext, runWithContext } from '../tracing/context';
import { decideAfterFailure, type BackoffPolicy } from './backoff';
import type { DeliveryTransport } from './http-transport';
import type { ClaimedDelivery, OutboxStore } from './outbox-store';
import type { SubscriptionTable } from './subscriptions';

export interface RelayOptions {
  pollIntervalMs: number;
  batchSize: number;
  /** Maximum deliveries in flight at once across all subscribers. */
  maxInFlight: number;
  /**
   * Maximum deliveries in flight at once for any single subscriber. Keeps the remaining capacity free
   * for the other subscribers, so a slow subscriber cannot hold them up. Must not exceed maxInFlight.
   */
  maxInFlightPerSubscriber: number;
  /** Lease on a claimed row; must exceed the delivery timeout. */
  leaseMs: number;
  backoff: BackoffPolicy;
}

/**
 * Outbox relay worker, run as its own PM2 process per producer.
 *
 * Each tick: fan new events out into per-subscriber delivery rows, bury abandoned rows that used their
 * last attempt, then claim due rows up to the free capacity and deliver them concurrently. Each
 * subscriber may use at most `maxInFlightPerSubscriber` slots, so a slow or failing subscriber only
 * occupies its own share; other subscribers' deliveries keep flowing.
 * Delivery is at-least-once: a crash after the subscriber committed but before markDelivered leaves the
 * row in flight; its lease expires and it is sent again, which the subscriber's inbox deduplicates.
 */
export class OutboxRelay {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly inFlightBySubscriber = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private ticking = false;

  constructor(
    private readonly store: OutboxStore,
    private readonly subscriptions: SubscriptionTable,
    private readonly transport: DeliveryTransport,
    private readonly options: RelayOptions,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.logger.info(
      { operation: 'relay_start', producer: this.subscriptions.producer, ...this.options },
      'relay started',
    );
    this.schedule(0);
  }

  /** Stops claiming new work and waits for in-flight deliveries to settle. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.inFlight]);
    this.logger.info({ operation: 'relay_stop' }, 'relay stopped');
  }

  /** One full cycle; exposed for tests. Resolves when the claimed deliveries have been dispatched. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.store.fanOut(this.subscriptions, this.options.batchSize);
      const buried = await this.store.buryAbandoned(this.options.backoff.maxAttempts);
      for (const row of buried) {
        this.logger.error(
          {
            operation: 'relay_dead',
            delivery_id: row.id,
            event_id: row.event_id,
            subscriber: row.subscriber,
          },
          'delivery marked dead after its final attempt was abandoned',
        );
      }
      const capacity = Math.min(
        this.options.batchSize,
        this.options.maxInFlight - this.inFlight.size,
      );
      const claimed = await this.store.claim(
        capacity,
        this.options.leaseMs,
        this.options.backoff.maxAttempts,
        { limit: this.options.maxInFlightPerSubscriber, busy: this.inFlightBySubscriber },
      );
      for (const delivery of claimed) {
        this.adjustSubscriberLoad(delivery.subscriber, 1);
        const task = this.deliver(delivery).finally(() => {
          this.inFlight.delete(task);
          this.adjustSubscriberLoad(delivery.subscriber, -1);
        });
        this.inFlight.add(task);
      }
    } catch (error) {
      this.logger.error({ operation: 'relay_tick', ...describeError(error) }, 'relay tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Waits for every delivery currently in flight (tests and graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private adjustSubscriberLoad(subscriber: string, delta: number): void {
    const next = (this.inFlightBySubscriber.get(subscriber) ?? 0) + delta;
    if (next > 0) this.inFlightBySubscriber.set(subscriber, next);
    else this.inFlightBySubscriber.delete(subscriber);
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(this.options.pollIntervalMs));
    }, delayMs);
  }

  private async deliver(delivery: ClaimedDelivery): Promise<void> {
    const context = createContext({
      requestId: delivery.envelope.request_id,
      traceparent: delivery.envelope.traceparent,
    });
    await runWithContext(context, async () => {
      const fields = {
        operation: 'relay_deliver',
        delivery_id: delivery.id,
        event_id: delivery.eventId,
        event_type: delivery.envelope.event_type,
        subscriber: delivery.subscriber,
        attempt: delivery.attempt,
      };
      try {
        const result = await this.transport.deliver(delivery.targetUrl, delivery.envelope);
        if (result.ok) {
          await this.store.markDelivered(delivery, result.statusCode);
          this.logger.info({ ...fields, status_code: result.statusCode }, 'event delivered');
          return;
        }
        const decision = decideAfterFailure(this.options.backoff, delivery.attempt);
        if (decision.action === 'dead') {
          await this.store.markDead(delivery, result.error, result.statusCode);
          this.logger.error(
            { ...fields, status_code: result.statusCode, error_message: result.error },
            'delivery marked dead after final attempt',
          );
        } else {
          await this.store.scheduleRetry(
            delivery,
            decision.delayMs,
            result.error,
            result.statusCode,
          );
          this.logger.warn(
            {
              ...fields,
              status_code: result.statusCode,
              error_message: result.error,
              retry_in_ms: decision.delayMs,
            },
            'delivery failed; retry scheduled',
          );
        }
      } catch (error) {
        // Bookkeeping failed (e.g. database down). The lease expires and the row is claimed again.
        this.logger.error({ ...fields, ...describeError(error) }, 'delivery bookkeeping failed');
      }
    });
  }
}
