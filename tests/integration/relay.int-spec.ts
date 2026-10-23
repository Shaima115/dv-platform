import {
  buildEnvelope,
  EventTypes,
  OutboxEventPublisher,
  OutboxRelay,
  OutboxStore,
  PgTransactionRunner,
  SubscriptionTable,
  type DeliveryResult,
  type DeliveryTransport,
  type EventEnvelope,
} from '@dv/shared';
import { v7 as uuidv7 } from 'uuid';
import { createTestDatabase, silentLogger, type TestDatabase } from './support/test-db';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  // Each test owns the verification outbox; core's runtime role cannot DELETE, so the test resets with UPDATE.
  await db.verification.query(
    "UPDATE compliance.outbox_delivery SET status = 'delivered' WHERE status <> 'delivered'",
  );
  await db.verification.query(
    'UPDATE compliance.outbox_event SET fanned_out_at = now() WHERE fanned_out_at IS NULL',
  );
});

const subscriptions = (subscribers: string[]) =>
  new SubscriptionTable({
    producer: 'verification',
    subscriptions: {
      [EventTypes.VERIFICATION_COMPLETED]: subscribers.map((name) => ({
        name,
        url: `http://svc-${name}.internal/internal/v1/events`,
      })),
    },
  });

const fastBackoff = { baseMs: 1, maxMs: 5, maxAttempts: 5 };
const relayOptions = {
  pollIntervalMs: 10,
  batchSize: 50,
  maxInFlight: 20,
  maxInFlightPerSubscriber: 5,
  leaseMs: 5_000,
  backoff: fastBackoff,
};

/** Records deliveries and answers per subscriber host. */
class FakeTransport implements DeliveryTransport {
  delivered: Array<{ url: string; eventId: string }> = [];
  constructor(
    private readonly answer: (
      url: string,
      e: EventEnvelope,
    ) => DeliveryResult | Promise<DeliveryResult> = () => ({ ok: true, statusCode: 200 }),
  ) {}
  async deliver(url: string, envelope: EventEnvelope): Promise<DeliveryResult> {
    const result = await this.answer(url, envelope);
    if (result.ok) this.delivered.push({ url, eventId: envelope.event_id });
    return result;
  }
}

async function publish(n: number): Promise<string[]> {
  const publisher = new OutboxEventPublisher('compliance');
  const runner = new PgTransactionRunner(db.verification);
  const eventIds: string[] = [];
  await runner.run(async (tx) => {
    for (let i = 0; i < n; i += 1) {
      const company = uuidv7();
      const envelope = buildEnvelope({
        eventType: EventTypes.VERIFICATION_COMPLETED,
        aggregateId: company,
        data: {
          verification_id: uuidv7(),
          company_id: company,
          decision: 'approved',
          reason_code: 'documents_valid',
        },
      });
      await publisher.publish(tx, envelope);
      eventIds.push(envelope.event_id);
    }
  });
  return eventIds;
}

const deliveries = async (eventIds: string[]) =>
  (
    await db.verification.query<{
      event_id: string;
      subscriber: string;
      status: string;
      attempts: number;
    }>(
      'SELECT event_id::text, subscriber, status, attempts FROM compliance.outbox_delivery WHERE event_id = ANY($1::uuid[]) ORDER BY id',
      [eventIds],
    )
  ).rows;

// Callers must check row counts, not just `every`, or an empty set counts as done.
async function runUntil(
  relay: OutboxRelay,
  done: () => Promise<boolean>,
  maxTicks = 200,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    await relay.tick();
    await relay.drain();
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('relay did not reach the expected state');
}

describe('outbox relay over PostgreSQL', () => {
  it('fans out one delivery row per subscriber and acknowledges on 2xx', async () => {
    const [eventId] = await publish(1);
    const transport = new FakeTransport();
    const relay = new OutboxRelay(
      new OutboxStore(db.verification, 'compliance'),
      subscriptions(['core', 'audit']),
      transport,
      relayOptions,
      silentLogger(),
    );
    await runUntil(relay, async () => {
      const rows = await deliveries([eventId!]);
      return rows.length === 2 && rows.every((d) => d.status === 'delivered');
    });
    const rows = await deliveries([eventId!]);
    expect(rows.map((r) => r.subscriber).sort()).toEqual(['audit', 'core']);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    expect(transport.delivered).toHaveLength(2);
  });

  it('does not mark delivered on a non-2xx; retries with backoff; dead after 5 attempts', async () => {
    const [eventId] = await publish(1);
    const transport = new FakeTransport(() => ({
      ok: false,
      statusCode: 500,
      error: 'subscriber answered 500',
    }));
    const relay = new OutboxRelay(
      new OutboxStore(db.verification, 'compliance'),
      subscriptions(['core']),
      transport,
      relayOptions,
      silentLogger(),
    );

    await relay.tick();
    await relay.drain();
    expect(await deliveries([eventId!])).toMatchObject([{ status: 'pending', attempts: 1 }]);

    await runUntil(relay, async () => (await deliveries([eventId!]))[0]!.status === 'dead');
    const [row] = await deliveries([eventId!]);
    expect(row).toMatchObject({ status: 'dead', attempts: 5 });
    const detail = await db.verification.query(
      'SELECT last_status_code, last_error FROM compliance.outbox_delivery WHERE event_id = $1',
      [eventId],
    );
    expect(detail.rows[0]).toMatchObject({
      last_status_code: 500,
      last_error: 'subscriber answered 500',
    });
  });

  it('one failing subscriber never blocks another subscriber or other events', async () => {
    const eventIds = await publish(3);
    const transport = new FakeTransport((url) =>
      url.includes('svc-broken')
        ? { ok: false, error: 'connection refused' }
        : { ok: true, statusCode: 200 },
    );
    const relay = new OutboxRelay(
      new OutboxStore(db.verification, 'compliance'),
      subscriptions(['core', 'broken']),
      transport,
      relayOptions,
      silentLogger(),
    );
    await runUntil(relay, async () => {
      const rows = await deliveries(eventIds);
      return (
        rows.length === 6 && rows.every((d) => d.status === 'delivered' || d.status === 'dead')
      );
    });
    const rows = await deliveries(eventIds);
    expect(rows.filter((r) => r.subscriber === 'core').every((r) => r.status === 'delivered')).toBe(
      true,
    );
    expect(rows.filter((r) => r.subscriber === 'broken').every((r) => r.status === 'dead')).toBe(
      true,
    );
  });

  it('one slow subscriber never holds up another (per-subscriber in-flight limit)', async () => {
    const eventIds = await publish(40);
    // The slow subscriber hangs until released, so without a per-subscriber limit it would occupy
    // every slot and the healthy subscriber would never be served.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slowInFlight = 0;
    let slowPeak = 0;
    const transport = new FakeTransport(async (url) => {
      if (url.includes('svc-slow')) {
        slowInFlight += 1;
        slowPeak = Math.max(slowPeak, slowInFlight);
        await gate;
        slowInFlight -= 1;
      }
      return { ok: true, statusCode: 200 };
    });
    const relay = new OutboxRelay(
      new OutboxStore(db.verification, 'compliance'),
      subscriptions(['core', 'slow']),
      transport,
      relayOptions,
      silentLogger(),
    );

    const healthyDone = async () => {
      const rows = (await deliveries(eventIds)).filter((r) => r.subscriber === 'core');
      return rows.length === 40 && rows.every((r) => r.status === 'delivered');
    };
    let served = false;
    for (let i = 0; i < 300 && !served; i += 1) {
      await relay.tick(); // no drain: the slow deliveries are still hanging on purpose
      served = await healthyDone();
      if (!served) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const slowWhileBlocked = (await deliveries(eventIds)).filter((r) => r.subscriber === 'slow');

    release();
    await relay.drain();
    await runUntil(relay, async () => {
      const rows = await deliveries(eventIds);
      return rows.length === 80 && rows.every((r) => r.status === 'delivered');
    });

    expect(served).toBe(true);
    expect(slowWhileBlocked.some((r) => r.status !== 'delivered')).toBe(true);
    expect(slowPeak).toBeLessThanOrEqual(relayOptions.maxInFlightPerSubscriber);
  });

  it('concurrent relay workers never deliver the same row twice (FOR UPDATE SKIP LOCKED)', async () => {
    const eventIds = await publish(60);
    const transport = new FakeTransport(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, statusCode: 200 };
    });
    const make = () =>
      new OutboxRelay(
        new OutboxStore(db.verification, 'compliance'),
        subscriptions(['core']),
        transport,
        { ...relayOptions, batchSize: 7 },
        silentLogger(),
      );
    const workers = [make(), make(), make(), make()];
    for (let round = 0; round < 50; round += 1) {
      await Promise.all(workers.map((w) => w.tick()));
      await Promise.all(workers.map((w) => w.drain()));
      const rows = await deliveries(eventIds);
      if (rows.length === 60 && rows.every((d) => d.status === 'delivered')) break;
    }
    const rows = await deliveries(eventIds);
    expect(rows).toHaveLength(60);
    expect(rows.every((d) => d.status === 'delivered' && d.attempts === 1)).toBe(true);
    const ours = transport.delivered.filter((d) => eventIds.includes(d.eventId));
    expect(ours).toHaveLength(60);
    expect(new Set(ours.map((d) => d.eventId)).size).toBe(60);
  });

  it('a delivery whose worker crashed is re-claimed after its lease expires (at-least-once)', async () => {
    const [eventId] = await publish(1);
    const store = new OutboxStore(db.verification, 'compliance');
    await store.fanOut(subscriptions(['core']), 10);
    const claimed = await store.claim(10, 50, 5);
    expect(claimed.map((c) => c.eventId)).toContain(eventId);
    // Simulate a crash: never acknowledge. A second claim before the lease expires gets nothing.
    expect((await store.claim(10, 50, 5)).map((c) => c.eventId)).not.toContain(eventId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const reclaimed = await store.claim(10, 5_000, 5);
    expect(reclaimed.find((c) => c.eventId === eventId)?.attempt).toBe(2);
    // The stale first claim can no longer acknowledge over the new one.
    expect(
      await store.markDelivered(
        claimed.find((c) => c.eventId === eventId)!,
        200,
      ),
    ).toBe(false);
  });

  it('dead deliveries can be re-queued and then delivered', async () => {
    const [eventId] = await publish(1);
    let healthy = false;
    const transport = new FakeTransport(() =>
      healthy ? { ok: true, statusCode: 200 } : { ok: false, statusCode: 503, error: 'down' },
    );
    const store = new OutboxStore(db.verification, 'compliance');
    const relay = new OutboxRelay(
      store,
      subscriptions(['core']),
      transport,
      relayOptions,
      silentLogger(),
    );
    await runUntil(relay, async () => (await deliveries([eventId!]))[0]?.status === 'dead');
    healthy = true;
    expect(await store.requeueDead()).toBeGreaterThanOrEqual(1);
    await runUntil(relay, async () => (await deliveries([eventId!]))[0]!.status === 'delivered');
    expect((await deliveries([eventId!]))[0]).toMatchObject({ status: 'delivered', attempts: 1 });
  });
});
