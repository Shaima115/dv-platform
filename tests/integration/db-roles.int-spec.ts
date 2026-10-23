import { createTestDatabase, type TestDatabase } from './support/test-db';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

const denied = async (pool: TestDatabase['core'], sql: string) => {
  await expect(pool.query(sql)).rejects.toThrow(/permission denied|must be owner/);
};

describe('least-privilege database roles', () => {
  it('each role reads its own schema', async () => {
    await expect(db.core.query('SELECT count(*) FROM profile.company')).resolves.toBeDefined();
    await expect(db.core.query('SELECT count(*) FROM core.outbox_event')).resolves.toBeDefined();
    await expect(
      db.verification.query('SELECT count(*) FROM compliance.verification_request'),
    ).resolves.toBeDefined();
    await expect(
      db.notification.query('SELECT count(*) FROM notification.notification'),
    ).resolves.toBeDefined();
  });

  it.each([
    ['core → compliance', 'core', 'SELECT * FROM compliance.verification_request'],
    ['core → notification', 'core', 'SELECT * FROM notification.notification'],
    ['verification → profile', 'verification', 'SELECT * FROM profile.company'],
    ['verification → identity', 'verification', 'SELECT * FROM identity.user_account'],
    ['verification → core outbox', 'verification', 'SELECT * FROM core.outbox_event'],
    ['notification → profile', 'notification', 'SELECT * FROM profile.company'],
    ['notification → compliance', 'notification', 'SELECT * FROM compliance.outbox_event'],
    ['notification → migrations ledger', 'notification', 'SELECT * FROM dv_migrations.applied'],
  ] as const)('%s is denied', async (_label, role, sql) => {
    await denied(db[role], sql);
  });

  it('runtime roles cannot run DDL, delete rows, or use the public schema', async () => {
    await denied(db.core, 'CREATE TABLE profile.evil (id int)');
    await denied(db.core, 'CREATE TABLE public.evil (id int)');
    await denied(db.core, 'DELETE FROM profile.company');
    await denied(db.verification, 'DROP TABLE compliance.verification_request');
    await denied(db.notification, 'TRUNCATE notification.notification');
  });

  it('runtime roles are plain login roles without inherited powers', async () => {
    const { rows } = await db.core.query(
      "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls FROM pg_roles WHERE rolname IN ('dv_core','dv_verification','dv_notification') ORDER BY rolname",
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolbypassrls: false,
      });
    }
    const membership = await db.core.query(
      "SELECT count(*) AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname LIKE 'dv\\_%'",
    );
    expect(Number(membership.rows[0].n)).toBe(0);
  });

  it('no table is owned by a runtime role', async () => {
    const { rows } = await db.core.query(
      "SELECT count(*) AS n FROM pg_tables WHERE schemaname IN ('identity','profile','core','compliance','notification') AND tableowner <> 'dv_migrator'",
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
