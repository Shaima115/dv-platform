import type { Transaction } from '@dv/shared';
import type { VerificationRequest } from '../domain/verification-request';

export type InsertOutcome =
  | { inserted: true }
  | { inserted: false; reason: 'idempotency_key_exists' | 'company_has_pending_request' };

export interface VerificationRepository {
  /** Inserts unless the (caller, idempotency key) already exists. Uses the DB unique constraint. */
  insertIdempotent(tx: Transaction, request: VerificationRequest): Promise<InsertOutcome>;
  findByIdempotencyKey(
    tx: Transaction,
    client: string,
    key: string,
  ): Promise<VerificationRequest | null>;
  findById(tx: Transaction, id: string): Promise<VerificationRequest | null>;
  findForUpdate(tx: Transaction, id: string): Promise<VerificationRequest | null>;
  save(tx: Transaction, request: VerificationRequest): Promise<void>;
}
