import {
  OutboxRelay,
  OutboxStore,
  parseIncomingEvent,
  SubscriptionTable,
  type CompanyApprovedV1,
  type DeliveryResult,
  type DeliveryTransport,
  type EventEnvelope,
  type VerificationCompletedV1,
} from '@dv/shared';
import { resolve } from 'node:path';
import {
  coreWiring,
  notificationWiring,
  owner,
  reviewer,
  svcCore,
  verificationWiring,
} from './support/fixtures';
import { createTestDatabase, silentLogger, type TestDatabase } from './support/test-db';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

/**
 * Delivers to the real consumer inboxes in-process, exactly as the HTTP controllers do:
 * parse + validate the untrusted body, run the transactional inbox, answer 200 only after commit.
 * (The live demo covers the same path over HTTP through Nginx.)
 */
class InProcessTransport implements DeliveryTransport {
  notificationUp = true;
  constructor(
    private readonly core = coreWiring(db.core),
    private readonly notification = notificationWiring(db.notification),
  ) {}

  async deliver(url: string, envelope: EventEnvelope): Promise<DeliveryResult> {
    const body: unknown = JSON.parse(JSON.stringify(envelope));
    try {
      if (url.startsWith('http://svc-core.internal/')) {
        const event = parseIncomingEvent<VerificationCompletedV1>(
          body,
          this.core.completedHandler.eventTypes,
        );
        await this.core.inbox.process(event, this.core.completedHandler);
        return { ok: true, statusCode: 200 };
      }
      if (url.startsWith('http://svc-notification.internal/')) {
        if (!this.notificationUp) return { ok: false, error: 'connect ECONNREFUSED' };
        const event = parseIncomingEvent<CompanyApprovedV1>(
          body,
          this.notification.handler.eventTypes,
        );
        await this.notification.inbox.process(event, this.notification.handler);
        return { ok: true, statusCode: 200 };
      }
      return { ok: false, statusCode: 404, error: 'unknown subscriber' };
    } catch (error) {
      return { ok: false, statusCode: 500, error: (error as Error).message };
    }
  }
}

const options = {
  pollIntervalMs: 10,
  batchSize: 50,
  maxInFlight: 10,
  maxInFlightPerSubscriber: 5,
  leaseMs: 5_000,
  backoff: { baseMs: 1, maxMs: 5, maxAttempts: 5 },
};
const subs = (file: string) =>
  SubscriptionTable.load(resolve(__dirname, '../../config/subscriptions', file));

async function pump(relays: OutboxRelay[], done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    for (const relay of relays) {
      await relay.tick();
      await relay.drain();
    }
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('pipeline did not settle');
}

async function approvedCompany(transport: InProcessTransport) {
  const core = coreWiring(db.core);
  const verification = verificationWiring(db.verification);
  const user = owner();
  const company = await core.createCompany.execute(user, {
    name: 'Pipeline Co',
    countryCode: 'JO',
  });
  const { view } = await verification.create.execute(svcCore, `vr-${company.id}`, {
    company_id: company.id,
    requested_by_subject: user.subject,
  });
  await core.transactions.run(async (tx) => {
    const c = await core.companies.findForUpdate(tx, company.id);
    c!.claimSubmission(new Date(), 10_000, () => `vr-${company.id}`);
    c!.markSubmitted(view.id, new Date());
    await core.companies.save(tx, c!);
  });
  await verification.decide.execute(reviewer(), view.id, {
    decision: 'approved',
    reasonCode: 'documents_valid',
  });
  const verificationRelay = new OutboxRelay(
    new OutboxStore(db.verification, 'compliance'),
    subs('verification.json'),
    transport,
    options,
    silentLogger(),
  );
  const coreRelay = new OutboxRelay(
    new OutboxStore(db.core, 'core'),
    subs('core.json'),
    transport,
    options,
    silentLogger(),
  );
  return {
    companyId: company.id,
    ownerSubject: user.subject,
    relays: [verificationRelay, coreRelay],
  };
}

const status = async (companyId: string) =>
  (await db.core.query('SELECT status FROM profile.company WHERE id = $1', [companyId])).rows[0]
    .status;
const notifications = async (companyId: string) =>
  (
    await db.notification.query(
      'SELECT recipient_subject, message_code FROM notification.notification WHERE company_id = $1',
      [companyId],
    )
  ).rows;

describe('outbox → relay → inbox, end to end over PostgreSQL', () => {
  it('a reviewer approval reaches core and then notification, once', async () => {
    const transport = new InProcessTransport();
    const { companyId, ownerSubject, relays } = await approvedCompany(transport);
    await pump(relays, async () => (await notifications(companyId)).length === 1);

    expect(await status(companyId)).toBe('approved');
    expect(await notifications(companyId)).toEqual([
      { recipient_subject: ownerSubject, message_code: 'COMPANY_APPROVED' },
    ]);

    // Redeliver everything (as after a relay crash before acknowledgement): no new side effects.
    await db.verification.query(
      "UPDATE compliance.outbox_delivery SET status = 'pending', attempts = 0 WHERE event_id IN (SELECT event_id FROM compliance.outbox_event WHERE aggregate_id = $1)",
      [companyId],
    );
    await db.core.query(
      "UPDATE core.outbox_delivery SET status = 'pending', attempts = 0 WHERE event_id IN (SELECT event_id FROM core.outbox_event WHERE aggregate_id = $1)",
      [companyId],
    );
    await pump(relays, async () => {
      const { rows } = await db.core.query(
        "SELECT count(*) AS n FROM core.outbox_delivery d JOIN core.outbox_event e USING (event_id) WHERE e.aggregate_id = $1 AND d.status <> 'delivered'",
        [companyId],
      );
      return Number(rows[0].n) === 0;
    });
    expect(await notifications(companyId)).toHaveLength(1);
    const approvedEvents = await db.core.query(
      "SELECT count(*) AS n FROM core.outbox_event WHERE aggregate_id = $1 AND event_type = 'dv.jo.core.company_approved.v1'",
      [companyId],
    );
    expect(Number(approvedEvents.rows[0].n)).toBe(1);
  });

  it('nothing is lost while notification is down: delivered after it comes back', async () => {
    const transport = new InProcessTransport();
    transport.notificationUp = false;
    const { companyId, relays } = await approvedCompany(transport);
    await pump(relays, async () => (await status(companyId)) === 'approved');
    for (let i = 0; i < 2; i += 1) {
      for (const relay of relays) {
        await relay.tick();
        await relay.drain();
      }
    }
    expect(await notifications(companyId)).toHaveLength(0);
    const pending = await db.core.query(
      'SELECT d.status, d.attempts FROM core.outbox_delivery d JOIN core.outbox_event e USING (event_id) WHERE e.aggregate_id = $1',
      [companyId],
    );
    expect(pending.rows[0].status).not.toBe('delivered');

    transport.notificationUp = true;
    await pump(relays, async () => (await notifications(companyId)).length === 1);
    expect(await notifications(companyId)).toHaveLength(1);
  });

  it('a consumer failure is retried and finally marked dead without blocking other events', async () => {
    const poisoned = new Set<string>();
    const transport = new InProcessTransport(
      coreWiring(db.core),
      notificationWiring(db.notification, { shouldFail: (id) => poisoned.has(id) }),
    );
    const bad = await approvedCompany(transport);
    poisoned.add(bad.companyId);
    const good = await approvedCompany(transport);
    await pump([...bad.relays, ...good.relays], async () => {
      const { rows } = await db.core.query(
        'SELECT d.status FROM core.outbox_delivery d JOIN core.outbox_event e USING (event_id) WHERE e.aggregate_id = $1',
        [bad.companyId],
      );
      return rows[0]?.status === 'dead' && (await notifications(good.companyId)).length === 1;
    });
    expect(await notifications(bad.companyId)).toHaveLength(0);
    const inbox = await db.notification.query(
      'SELECT count(*) AS n FROM notification.inbox_processed i JOIN notification.notification n USING (event_id) WHERE n.company_id = $1',
      [bad.companyId],
    );
    expect(Number(inbox.rows[0].n)).toBe(0);
  });
});
