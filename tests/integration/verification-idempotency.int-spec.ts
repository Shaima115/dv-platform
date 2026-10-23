import { v7 as uuidv7 } from 'uuid';
import { svcCore, verificationWiring } from './support/fixtures';
import { createTestDatabase, type TestDatabase } from './support/test-db';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

const rows = async (key: string) =>
  Number(
    (
      await db.verification.query<{ n: string }>(
        'SELECT count(*) AS n FROM compliance.verification_request WHERE idempotency_key = $1',
        [key],
      )
    ).rows[0]!.n,
  );

describe('verification idempotency (database-enforced)', () => {
  it('a repeated key returns the original request and creates no second row', async () => {
    const { create } = verificationWiring(db.verification);
    const input = { company_id: uuidv7(), requested_by_subject: 'owner-1' };
    const first = await create.execute(svcCore, 'key-sequential-1', input);
    const second = await create.execute(svcCore, 'key-sequential-1', input);
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ replayed: true, view: first.view });
    expect(await rows('key-sequential-1')).toBe(1);
  });

  it('twenty concurrent requests with one key produce exactly one row and one id', async () => {
    const { create } = verificationWiring(db.verification);
    const input = { company_id: uuidv7(), requested_by_subject: 'owner-2' };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => create.execute(svcCore, 'key-concurrent-1', input)),
    );
    expect(new Set(results.map((r) => r.view.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await rows('key-concurrent-1')).toBe(1);
  });

  it('the same key with different parameters is a 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { create } = verificationWiring(db.verification);
    await create.execute(svcCore, 'key-reused-1', {
      company_id: uuidv7(),
      requested_by_subject: 'a',
    });
    await expect(
      create.execute(svcCore, 'key-reused-1', { company_id: uuidv7(), requested_by_subject: 'a' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await rows('key-reused-1')).toBe(1);
  });

  it('keys are scoped to the calling service', async () => {
    const { create } = verificationWiring(db.verification);
    await create.execute(svcCore, 'key-scope-1', {
      company_id: uuidv7(),
      requested_by_subject: 'a',
    });
    const other = await create.execute({ ...svcCore, clientId: 'svc-other' }, 'key-scope-1', {
      company_id: uuidv7(),
      requested_by_subject: 'a',
    });
    expect(other.replayed).toBe(false);
  });

  it('a different key for a company that already has an open request is refused', async () => {
    const { create } = verificationWiring(db.verification);
    const company = uuidv7();
    await create.execute(svcCore, 'key-open-1', { company_id: company, requested_by_subject: 'a' });
    await expect(
      create.execute(svcCore, 'key-open-2', { company_id: company, requested_by_subject: 'a' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'VERIFICATION_ALREADY_PENDING',
    });
  });

  it('the decision and the verification.completed outbox row commit together, once', async () => {
    const { create, decide } = verificationWiring(db.verification);
    const company = uuidv7();
    const { view } = await create.execute(svcCore, 'key-decide-1', {
      company_id: company,
      requested_by_subject: 'a',
    });
    const reviewer = {
      kind: 'user' as const,
      subject: 'r',
      clientId: 'web',
      realmRoles: new Set(['reviewer']),
    };
    await decide.execute(reviewer, view.id, {
      decision: 'approved',
      reasonCode: 'documents_valid',
    });
    await expect(
      decide.execute(reviewer, view.id, { decision: 'rejected', reasonCode: 'late' }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_ALREADY_DECIDED' });
    const events = await db.verification.query(
      'SELECT payload FROM compliance.outbox_event WHERE aggregate_id = $1',
      [company],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.data).toMatchObject({
      decision: 'approved',
      verification_id: view.id,
    });
  });

  it('owners cannot decide, whatever company they own', async () => {
    const { create, decide } = verificationWiring(db.verification);
    const { view } = await create.execute(svcCore, 'key-owner-1', {
      company_id: uuidv7(),
      requested_by_subject: 'a',
    });
    const ownerUser = {
      kind: 'user' as const,
      subject: 'a',
      clientId: 'web',
      realmRoles: new Set<string>(),
    };
    await expect(
      decide.execute(ownerUser, view.id, { decision: 'approved', reasonCode: 'documents_valid' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_ACTION' });
  });
});
