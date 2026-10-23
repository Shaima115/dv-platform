import type { Transaction } from '@dv/shared';
import type { InsertOutcome, VerificationRepository } from '../application/verification-repository';
import { VerificationRequest, type VerificationStatus } from '../domain/verification-request';

interface Row {
  id: string;
  company_id: string;
  requested_by_client: string;
  requested_by_subject: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: VerificationStatus;
  decision_reason_code: string | null;
  decision_comment: string | null;
  decided_by_subject: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, company_id, requested_by_client, requested_by_subject, idempotency_key, request_fingerprint, status,
  decision_reason_code, decision_comment, decided_by_subject, decided_at, created_at, updated_at`;

const toDomain = (r: Row) =>
  VerificationRequest.restore({
    id: r.id,
    companyId: r.company_id,
    requestedByClient: r.requested_by_client,
    requestedBySubject: r.requested_by_subject,
    idempotencyKey: r.idempotency_key,
    requestFingerprint: r.request_fingerprint,
    status: r.status,
    decisionReasonCode: r.decision_reason_code,
    decisionComment: r.decision_comment,
    decidedBySubject: r.decided_by_subject,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

export class PgVerificationRepository implements VerificationRepository {
  async insertIdempotent(tx: Transaction, request: VerificationRequest): Promise<InsertOutcome> {
    const s = request.snapshot();
    try {
      const result = await tx.query(
        `INSERT INTO compliance.verification_request
           (id, company_id, requested_by_client, requested_by_subject, idempotency_key, request_fingerprint, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $7)
         ON CONFLICT ON CONSTRAINT verification_request_idempotency_uq DO NOTHING`,
        [
          s.id,
          s.companyId,
          s.requestedByClient,
          s.requestedBySubject,
          s.idempotencyKey,
          s.requestFingerprint,
          s.createdAt,
        ],
      );
      return result.rowCount === 1
        ? { inserted: true }
        : { inserted: false, reason: 'idempotency_key_exists' };
    } catch (error) {
      const pgError = error as { code?: string; constraint?: string };
      if (
        pgError.code === '23505' &&
        pgError.constraint === 'verification_request_one_pending_uq'
      ) {
        return { inserted: false, reason: 'company_has_pending_request' };
      }
      throw error;
    }
  }

  async findByIdempotencyKey(
    tx: Transaction,
    client: string,
    key: string,
  ): Promise<VerificationRequest | null> {
    const { rows } = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM compliance.verification_request WHERE requested_by_client = $1 AND idempotency_key = $2`,
      [client, key],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findById(tx: Transaction, id: string): Promise<VerificationRequest | null> {
    const { rows } = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM compliance.verification_request WHERE id = $1`,
      [id],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findForUpdate(tx: Transaction, id: string): Promise<VerificationRequest | null> {
    const { rows } = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM compliance.verification_request WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async save(tx: Transaction, request: VerificationRequest): Promise<void> {
    const s = request.snapshot();
    await tx.query(
      `UPDATE compliance.verification_request
          SET status = $2, decision_reason_code = $3, decision_comment = $4, decided_by_subject = $5, decided_at = $6, updated_at = $7
        WHERE id = $1`,
      [
        s.id,
        s.status,
        s.decisionReasonCode,
        s.decisionComment,
        s.decidedBySubject,
        s.decidedAt,
        s.updatedAt,
      ],
    );
  }
}
