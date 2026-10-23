import {
  buildEnvelope,
  EventTypes,
  type EventEnvelope,
  type EventHandler,
  type EventHandlingResult,
  type EventPublisher,
  type Transaction,
  type VerificationCompletedV1,
} from '@dv/shared';
import { CompanyNotFoundError } from '../../domain/company/company-errors';
import type { CompanyRepository, MembershipRepository } from '../ports/repositories';
import type { Clock } from '../ports/runtime';

/**
 * Consumes dv.jo.verification.completed.v1 inside the inbox transaction: locks the company, applies the
 * result through the state machine, and — only on approval — records company_approved in the outbox
 * in the same transaction. Stale or duplicate results are acknowledged and ignored, never retried.
 */
export class HandleVerificationCompleted implements EventHandler<VerificationCompletedV1> {
  readonly eventTypes = [EventTypes.VERIFICATION_COMPLETED];

  constructor(
    private readonly companies: CompanyRepository,
    private readonly memberships: MembershipRepository,
    private readonly events: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async handle(
    tx: Transaction,
    event: EventEnvelope<VerificationCompletedV1>,
  ): Promise<EventHandlingResult> {
    const company = await this.companies.findForUpdate(tx, event.data.company_id);
    if (!company) throw new CompanyNotFoundError();

    const result = company.applyVerificationResult({
      verificationId: event.data.verification_id,
      decision: event.data.decision,
      reasonCode: event.data.reason_code,
      now: this.clock.now(),
    });
    if (result.outcome === 'ignored') {
      return { outcome: 'ignored', reason: result.reason };
    }

    await this.companies.save(tx, company);
    if (result.event) {
      const owners = await this.memberships.ownerSubjects(tx, company.id);
      for (const ownerSubject of owners) {
        await this.events.publish(
          tx,
          buildEnvelope({
            eventType: EventTypes.COMPANY_APPROVED,
            aggregateId: company.id,
            data: {
              company_id: company.id,
              verification_id: result.event.verificationId,
              owner_subject: ownerSubject,
            },
          }),
        );
      }
    }
    return { outcome: 'applied' };
  }
}
