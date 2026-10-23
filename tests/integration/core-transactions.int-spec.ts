import type { EventPublisher } from '@dv/shared';
import { coreWiring, owner } from './support/fixtures';
import { createTestDatabase, type TestDatabase } from './support/test-db';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

const count = async (sql: string, values: unknown[] = []) =>
  Number((await db.core.query<{ n: string }>(sql, values)).rows[0]!.n);

describe('company creation is atomic', () => {
  it('commits company, owner membership, user account and company_created outbox row together', async () => {
    const user = owner();
    const view = await coreWiring(db.core).createCompany.execute(user, {
      name: 'Atomic Co',
      countryCode: 'JO',
    });

    expect(view.status).toBe('draft');
    expect(await count('SELECT count(*) AS n FROM profile.company WHERE id = $1', [view.id])).toBe(
      1,
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM profile.company_member WHERE company_id = $1 AND role = 'owner'",
        [view.id],
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM identity.user_account WHERE keycloak_sub = $1', [
        user.subject,
      ]),
    ).toBe(1);
    const { rows } = await db.core.query<{
      event_type: string;
      payload: { data: Record<string, string> };
    }>('SELECT event_type, payload FROM core.outbox_event WHERE aggregate_id = $1', [view.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('dv.jo.core.company_created.v1');
    expect(Object.keys(rows[0]!.payload.data).sort()).toEqual([
      'company_id',
      'country_code',
      'owner_user_id',
    ]);
  });

  it('rolls everything back when the outbox write fails — no company without its event', async () => {
    const user = owner();
    const failing: EventPublisher = {
      publish: async () => {
        throw new Error('outbox unavailable');
      },
    };
    await expect(
      coreWiring(db.core, failing).createCompany.execute(user, {
        name: 'Ghost Co',
        countryCode: 'JO',
      }),
    ).rejects.toThrow('outbox unavailable');

    expect(await count("SELECT count(*) AS n FROM profile.company WHERE name = 'Ghost Co'")).toBe(
      0,
    );
    expect(
      await count('SELECT count(*) AS n FROM identity.user_account WHERE keycloak_sub = $1', [
        user.subject,
      ]),
    ).toBe(0);
  });

  it('creates one user account even when a new user sends concurrent first requests', async () => {
    const user = owner();
    const wiring = coreWiring(db.core);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        wiring.createCompany.execute(user, { name: `Race ${i}`, countryCode: 'JO' }),
      ),
    );
    expect(
      await count('SELECT count(*) AS n FROM identity.user_account WHERE keycloak_sub = $1', [
        user.subject,
      ]),
    ).toBe(1);
  });
});
