import {
  OutboxEventPublisher,
  PgTransactionRunner,
  TransactionalInbox,
  type EventPublisher,
  type Transaction,
  type UserPrincipal,
} from '@dv/shared';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { PgCompanyRepository } from '../../../apps/core/src/adapters/persistence/pg-company.repository';
import { PgMembershipRepository } from '../../../apps/core/src/adapters/persistence/pg-membership.repository';
import { PgUserAccountRepository } from '../../../apps/core/src/adapters/persistence/pg-user-account.repository';
import { CreateCompanyUseCase } from '../../../apps/core/src/application/use-cases/create-company';
import { HandleVerificationCompleted } from '../../../apps/core/src/application/use-cases/handle-verification-completed';
import { PgNotificationRepository } from '../../../apps/notification/src/adapters/pg-notification.repository';
import { HandleCompanyApproved } from '../../../apps/notification/src/application/use-cases';
import { PgVerificationRepository } from '../../../apps/verification/src/adapters/pg-verification.repository';
import {
  CreateVerificationRequestUseCase,
  DecideVerificationUseCase,
} from '../../../apps/verification/src/application/use-cases';
import { silentLogger } from './test-db';

export const clock = { now: () => new Date() };
export const ids = { next: () => uuidv7() };

export const owner = (subject = `owner-${uuidv7()}`): UserPrincipal => ({
  kind: 'user',
  subject,
  clientId: 'web',
  realmRoles: new Set(),
});
export const reviewer = (): UserPrincipal => ({
  kind: 'user',
  subject: `reviewer-${uuidv7()}`,
  clientId: 'web',
  realmRoles: new Set(['reviewer']),
});

/** Wires core's real use cases and repositories against a pool. */
export function coreWiring(
  pool: Pool,
  publisher: EventPublisher = new OutboxEventPublisher('core'),
) {
  const transactions = new PgTransactionRunner(pool);
  const accounts = new PgUserAccountRepository(ids);
  const companies = new PgCompanyRepository();
  const memberships = new PgMembershipRepository();
  return {
    transactions,
    accounts,
    companies,
    memberships,
    createCompany: new CreateCompanyUseCase(
      transactions,
      accounts,
      companies,
      memberships,
      publisher,
      clock,
      ids,
    ),
    completedHandler: new HandleVerificationCompleted(
      companies,
      memberships,
      new OutboxEventPublisher('core'),
      clock,
    ),
    inbox: new TransactionalInbox('core', 'core', transactions, silentLogger()),
  };
}

export function verificationWiring(pool: Pool) {
  const transactions = new PgTransactionRunner(pool);
  const repository = new PgVerificationRepository();
  return {
    transactions,
    create: new CreateVerificationRequestUseCase(transactions, repository, clock, ids),
    decide: new DecideVerificationUseCase(
      transactions,
      repository,
      new OutboxEventPublisher('compliance'),
      clock,
    ),
  };
}

export function notificationWiring(
  pool: Pool,
  faults?: { shouldFail(companyId: string): boolean },
) {
  const transactions = new PgTransactionRunner(pool);
  return {
    handler: new HandleCompanyApproved(
      new PgNotificationRepository(),
      ids,
      clock,
      silentLogger(),
      faults,
    ),
    inbox: new TransactionalInbox('notification', 'notification', transactions, silentLogger()),
  };
}

/** Moves a freshly created company to pending as core would after verification accepted it. */
export async function markPending(
  pool: Pool,
  companyId: string,
  verificationId: string,
): Promise<void> {
  const wiring = coreWiring(pool);
  await wiring.transactions.run(async (tx: Transaction) => {
    const company = await wiring.companies.findForUpdate(tx, companyId);
    company!.claimSubmission(new Date(), 10_000, () => `vr-${uuidv7()}`);
    company!.markSubmitted(verificationId, new Date());
    await wiring.companies.save(tx, company!);
  });
}

export const svcCore = { kind: 'service' as const, clientId: 'svc-core', subject: 'sa-core' };
