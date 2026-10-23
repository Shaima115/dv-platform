import type { Transaction } from '@dv/shared';
import type { UserAccount, UserAccountRepository } from '../../application/ports/repositories';
import type { IdGenerator } from '../../application/ports/runtime';

export class PgUserAccountRepository implements UserAccountRepository {
  constructor(private readonly ids: IdGenerator) {}

  /**
   * Race-safe upsert: two first requests from the same new user both end up with the same row.
   * The no-op DO UPDATE makes RETURNING yield the existing row on conflict.
   */
  async ensure(tx: Transaction, keycloakSub: string): Promise<UserAccount> {
    const { rows } = await tx.query<{ id: string; keycloak_sub: string }>(
      `INSERT INTO identity.user_account (id, keycloak_sub)
       VALUES ($1, $2)
       ON CONFLICT (keycloak_sub) DO UPDATE SET keycloak_sub = EXCLUDED.keycloak_sub
       RETURNING id, keycloak_sub`,
      [this.ids.next(), keycloakSub],
    );
    const row = rows[0]!;
    return { id: row.id, keycloakSub: row.keycloak_sub };
  }

  async findById(tx: Transaction, id: string): Promise<UserAccount | null> {
    const { rows } = await tx.query<{ id: string; keycloak_sub: string }>(
      'SELECT id, keycloak_sub FROM identity.user_account WHERE id = $1',
      [id],
    );
    return rows[0] ? { id: rows[0].id, keycloakSub: rows[0].keycloak_sub } : null;
  }
}
