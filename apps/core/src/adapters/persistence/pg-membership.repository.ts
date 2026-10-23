import type { Transaction } from '@dv/shared';
import type { CompanyRole } from '../../domain/company/company-role';
import type { MembershipRepository } from '../../application/ports/repositories';

export class PgMembershipRepository implements MembershipRepository {
  async add(
    tx: Transaction,
    companyId: string,
    userAccountId: string,
    role: CompanyRole,
  ): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO profile.company_member (company_id, user_account_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, user_account_id) DO NOTHING`,
      [companyId, userAccountId, role],
    );
    return result.rowCount === 1;
  }

  async roleOf(
    tx: Transaction,
    companyId: string,
    userAccountId: string,
  ): Promise<CompanyRole | null> {
    const { rows } = await tx.query<{ role: CompanyRole }>(
      'SELECT role FROM profile.company_member WHERE company_id = $1 AND user_account_id = $2',
      [companyId, userAccountId],
    );
    return rows[0]?.role ?? null;
  }

  async ownerSubjects(tx: Transaction, companyId: string): Promise<string[]> {
    const { rows } = await tx.query<{ keycloak_sub: string }>(
      `SELECT u.keycloak_sub
         FROM profile.company_member m
         JOIN identity.user_account u ON u.id = m.user_account_id
        WHERE m.company_id = $1 AND m.role = 'owner'
        ORDER BY u.keycloak_sub`,
      [companyId],
    );
    return rows.map((row) => row.keycloak_sub);
  }
}
