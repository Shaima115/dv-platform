import type { Transaction } from '@dv/shared';
import { Company, type CompanyProps } from '../../domain/company/company';
import type { CompanyRole } from '../../domain/company/company-role';
import type { CompanyStatus } from '../../domain/company/company-status';
import type { CompanyRepository, CompanySummary, Page } from '../../application/ports/repositories';

interface CompanyRow {
  id: string;
  name: string;
  registration_number: string | null;
  country_code: string;
  status: CompanyStatus;
  verification_id: string | null;
  verification_submission_key: string | null;
  submission_claimed_until: Date | null;
  decision_reason_code: string | null;
  decided_at: Date | null;
  created_by: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, name, registration_number, country_code, status, verification_id, verification_submission_key,
  submission_claimed_until, decision_reason_code, decided_at, created_by, version, created_at, updated_at`;

function toDomain(row: CompanyRow): Company {
  const props: CompanyProps = {
    id: row.id,
    name: row.name,
    registrationNumber: row.registration_number,
    countryCode: row.country_code,
    status: row.status,
    verificationId: row.verification_id,
    verificationSubmissionKey: row.verification_submission_key,
    submissionClaimedUntil: row.submission_claimed_until,
    decisionReasonCode: row.decision_reason_code,
    decidedAt: row.decided_at,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return Company.restore(props);
}

export class PgCompanyRepository implements CompanyRepository {
  async insert(tx: Transaction, company: Company): Promise<void> {
    const c = company.snapshot();
    await tx.query(
      `INSERT INTO profile.company (id, name, registration_number, country_code, status, created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        c.id,
        c.name,
        c.registrationNumber,
        c.countryCode,
        c.status,
        c.createdBy,
        c.version,
        c.createdAt,
        c.updatedAt,
      ],
    );
  }

  async findForUpdate(tx: Transaction, id: string): Promise<Company | null> {
    const { rows } = await tx.query<CompanyRow>(
      `SELECT ${COLUMNS} FROM profile.company WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findById(tx: Transaction, id: string): Promise<Company | null> {
    const { rows } = await tx.query<CompanyRow>(
      `SELECT ${COLUMNS} FROM profile.company WHERE id = $1`,
      [id],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  /** Optimistic check on version on top of the row lock: a lost update fails loudly instead of silently. */
  async save(tx: Transaction, company: Company): Promise<void> {
    const c = company.snapshot();
    const result = await tx.query(
      `UPDATE profile.company
          SET status = $2, verification_id = $3, verification_submission_key = $4, submission_claimed_until = $5,
              decision_reason_code = $6, decided_at = $7, updated_at = $8, version = version + 1
        WHERE id = $1 AND version = $9`,
      [
        c.id,
        c.status,
        c.verificationId,
        c.verificationSubmissionKey,
        c.submissionClaimedUntil,
        c.decisionReasonCode,
        c.decidedAt,
        c.updatedAt,
        c.version,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Concurrent modification of company ${c.id}`);
    }
  }

  async listForMember(
    tx: Transaction,
    userAccountId: string,
    page: Page,
  ): Promise<{ items: CompanySummary[]; total: number }> {
    const { rows } = await tx.query<{
      id: string;
      name: string;
      country_code: string;
      status: string;
      role: CompanyRole;
      created_at: Date;
      total: string;
    }>(
      `SELECT c.id, c.name, c.country_code, c.status, m.role, c.created_at, count(*) OVER () AS total
         FROM profile.company_member m
         JOIN profile.company c ON c.id = m.company_id
        WHERE m.user_account_id = $1
        ORDER BY c.created_at DESC, c.id
        LIMIT $2 OFFSET $3`,
      [userAccountId, page.limit, page.offset],
    );
    let total = Number(rows[0]?.total ?? 0);
    if (rows.length === 0 && page.offset > 0) {
      const count = await tx.query<{ n: string }>(
        'SELECT count(*) AS n FROM profile.company_member WHERE user_account_id = $1',
        [userAccountId],
      );
      total = Number(count.rows[0]?.n ?? 0);
    }
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        countryCode: row.country_code,
        status: row.status,
        role: row.role,
        createdAt: row.created_at,
      })),
      total,
    };
  }
}
