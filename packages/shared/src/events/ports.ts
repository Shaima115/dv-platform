import type { Transaction } from '../database/database';
import type { EventEnvelope } from './envelope';

/**
 * Transport-independent publishing port. Application code records events through this inside its
 * transaction; how they travel (HTTP relay today, a broker later) is an adapter concern.
 */
export interface EventPublisher {
  publish(tx: Transaction, envelope: EventEnvelope): Promise<void>;
}

/** Transport-independent consumer port. The inbox adapter calls it inside the consumer transaction. */
export interface EventHandler<TData = Record<string, unknown>> {
  readonly eventTypes: readonly string[];
  handle(tx: Transaction, event: EventEnvelope<TData>): Promise<EventHandlingResult>;
}

/** `applied` changed state; `ignored` was safely discarded (e.g. stale) but is still acknowledged. */
export type EventHandlingResult = { outcome: 'applied' } | { outcome: 'ignored'; reason: string };
