import {
  buildEnvelope,
  EventTypes,
  type EventEnvelope,
  type VerificationCompletedV1,
} from '@dv/shared';
import { v7 as uuidv7 } from 'uuid';
import { coreWiring, markPending, owner } from './support/fixtures';
import { createTestDatabase, type TestDatabase } from './support/test-db';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

async function pendingCompany(): Promise<{ companyId: string; verificationId: string }> {
  const view = await coreWiring(db.core).createCompany.execute(owner(), {
    name: 'Inbox Co',
    countryCode: 'JO',
  });
  const verificationId = uuidv7();
  await markPending(db.core, view.id, verificationId);
  return { companyId: view.id, verificationId };
}

const completed = (
  companyId: string,
  verificationId: string,
  decision: 'approved' | 'rejected' = 'approved',
) =>
  buildEnvelope({
    eventType: EventTypes.VERIFICATION_COMPLETED,
    aggregateId: companyId,
    data: {
      verification_id: verificationId,
      company_id: companyId,
      decision,
      reason_code: 'documents_valid',
    },
  }) as EventEnvelope<VerificationCompletedV1>;

const q = async (sql: string, values: unknown[]) => (await db.core.query(sql, values)).rows;

describe('transactional inbox in core', () => {
  it('applies an event once; a duplicate is acknowledged without side effects', async () => {
    const { companyId, verificationId } = await pendingCompany();
    const { inbox, completedHandler } = coreWiring(db.core);
    const event = completed(companyId, verificationId);

    expect(await inbox.process(event, completedHandler)).toEqual({
      status: 'processed',
      result: { outcome: 'applied' },
    });
    expect(await inbox.process(event, completedHandler)).toEqual({ status: 'duplicate' });

    expect(
      (await q('SELECT status, version FROM profile.company WHERE id = $1', [companyId]))[0],
    ).toMatchObject({ status: 'approved', version: 3 });
    expect(
      await q(
        "SELECT 1 FROM core.outbox_event WHERE aggregate_id = $1 AND event_type = 'dv.jo.core.company_approved.v1'",
        [companyId],
      ),
    ).toHaveLength(1);
  });

  it('concurrent duplicates: exactly one is processed', async () => {
    const { companyId, verificationId } = await pendingCompany();
    const { inbox, completedHandler } = coreWiring(db.core);
    const event = completed(companyId, verificationId);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => inbox.process(event, completedHandler)),
    );
    expect(results.filter((r) => r.status === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(9);
    expect(
      await q(
        "SELECT 1 FROM core.outbox_event WHERE aggregate_id = $1 AND event_type = 'dv.jo.core.company_approved.v1'",
        [companyId],
      ),
    ).toHaveLength(1);
  });

  it('a failing handler rolls back the inbox row and every change, so the event can be retried', async () => {
    const { companyId, verificationId } = await pendingCompany();
    const { inbox, completedHandler } = coreWiring(db.core);
    const event = completed(companyId, verificationId);
    const broken = {
      eventTypes: completedHandler.eventTypes,
      handle: async (tx: never, e: never) => {
        await completedHandler.handle(tx, e);
        throw new Error('boom after the update');
      },
    };

    await expect(inbox.process(event, broken)).rejects.toThrow('boom');
    expect(
      await q('SELECT 1 FROM core.inbox_processed WHERE event_id = $1', [event.event_id]),
    ).toHaveLength(0);
    expect(
      (await q('SELECT status FROM profile.company WHERE id = $1', [companyId]))[0].status,
    ).toBe('pending');
    expect(
      await q('SELECT 1 FROM core.outbox_event WHERE aggregate_id = $1 AND event_type = $2', [
        companyId,
        EventTypes.COMPANY_APPROVED,
      ]),
    ).toHaveLength(0);

    expect((await inbox.process(event, completedHandler)).status).toBe('processed');
  });

  it('a stale contradictory event is recorded as ignored and never reverses a final state', async () => {
    const { companyId, verificationId } = await pendingCompany();
    const { inbox, completedHandler } = coreWiring(db.core);
    await inbox.process(completed(companyId, verificationId, 'approved'), completedHandler);
    const late = completed(companyId, verificationId, 'rejected');
    expect(await inbox.process(late, completedHandler)).toMatchObject({
      status: 'processed',
      result: { outcome: 'ignored' },
    });
    expect(
      (await q('SELECT status FROM profile.company WHERE id = $1', [companyId]))[0].status,
    ).toBe('approved');
    expect(
      (await q('SELECT outcome FROM core.inbox_processed WHERE event_id = $1', [late.event_id]))[0]
        .outcome,
    ).toBe('ignored');
  });

  it('a rejection emits no company_approved event', async () => {
    const { companyId, verificationId } = await pendingCompany();
    const { inbox, completedHandler } = coreWiring(db.core);
    await inbox.process(completed(companyId, verificationId, 'rejected'), completedHandler);
    expect(
      (await q('SELECT status FROM profile.company WHERE id = $1', [companyId]))[0].status,
    ).toBe('rejected');
    expect(
      await q('SELECT 1 FROM core.outbox_event WHERE aggregate_id = $1 AND event_type = $2', [
        companyId,
        EventTypes.COMPANY_APPROVED,
      ]),
    ).toHaveLength(0);
  });
});
