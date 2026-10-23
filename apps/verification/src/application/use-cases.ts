import {
  buildEnvelope,
  conflict,
  EventTypes,
  requestFingerprint,
  type EventPublisher,
  type ServicePrincipal,
  type TransactionRunner,
  type UserPrincipal,
} from '@dv/shared';
import { mayPerform } from '../domain/policy';
import {
  notAReviewer,
  requestNotFound,
  VerificationRequest,
  type Decision,
} from '../domain/verification-request';
import type { VerificationRepository } from './verification-repository';
import { toView, type VerificationView } from './verification-view';

export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  next(): string;
}

export interface CreateVerificationInput {
  company_id: string;
  requested_by_subject: string;
}

/**
 * Idempotent creation. The (caller, key) unique constraint is the arbiter: a concurrent duplicate
 * waits for the first insert to commit, then sees the conflict and returns the original request.
 * The same key with a different body is a 409, never a second request.
 */
export class CreateVerificationRequestUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly repository: VerificationRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute(
    caller: ServicePrincipal,
    idempotencyKey: string,
    input: CreateVerificationInput,
  ): Promise<{ replayed: boolean; view: VerificationView }> {
    const fingerprint = requestFingerprint(input);
    return this.transactions.run(async (tx) => {
      const candidate = VerificationRequest.open({
        id: this.ids.next(),
        companyId: input.company_id,
        requestedByClient: caller.clientId,
        requestedBySubject: input.requested_by_subject,
        idempotencyKey,
        requestFingerprint: fingerprint,
        createdAt: this.clock.now(),
      });
      const outcome = await this.repository.insertIdempotent(tx, candidate);
      if (outcome.inserted) {
        return { replayed: false, view: toView(candidate) };
      }
      if (outcome.reason === 'company_has_pending_request') {
        throw conflict(
          'VERIFICATION_ALREADY_PENDING',
          'This company already has an open verification request.',
        );
      }
      const existing = await this.repository.findByIdempotencyKey(
        tx,
        caller.clientId,
        idempotencyKey,
      );
      if (!existing) {
        throw new Error('idempotency conflict reported but the original request is missing');
      }
      if (existing.snapshot().requestFingerprint !== fingerprint) {
        throw conflict(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used with different parameters.',
        );
      }
      return { replayed: true, view: toView(existing) };
    });
  }
}

export class GetVerificationRequestUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly repository: VerificationRepository,
  ) {}

  execute(id: string): Promise<VerificationView> {
    return this.transactions.run(async (tx) => {
      const request = await this.repository.findById(tx, id);
      if (!request) throw requestNotFound();
      return toView(request);
    });
  }
}

/**
 * Reviewer decision: the decision row and the verification.completed outbox event commit together.
 * Nothing calls core here; the relay delivers the event.
 */
export class DecideVerificationUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly repository: VerificationRepository,
    private readonly events: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async execute(
    reviewer: UserPrincipal,
    id: string,
    input: { decision: Decision; reasonCode: string; comment?: string },
  ): Promise<VerificationView> {
    if (!mayPerform('verification:decide', { kind: 'user', platformRoles: reviewer.realmRoles })) {
      throw notAReviewer();
    }
    return this.transactions.run(async (tx) => {
      const request = await this.repository.findForUpdate(tx, id);
      if (!request) throw requestNotFound();
      request.decide({
        decision: input.decision,
        reasonCode: input.reasonCode,
        comment: input.comment ?? null,
        reviewerSubject: reviewer.subject,
        now: this.clock.now(),
      });
      await this.repository.save(tx, request);
      const s = request.snapshot();
      await this.events.publish(
        tx,
        buildEnvelope({
          eventType: EventTypes.VERIFICATION_COMPLETED,
          aggregateId: s.companyId,
          data: {
            verification_id: s.id,
            company_id: s.companyId,
            decision: input.decision,
            reason_code: input.reasonCode,
          },
        }),
      );
      return toView(request);
    });
  }
}
