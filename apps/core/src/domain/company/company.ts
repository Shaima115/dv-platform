import type { CompanyApprovedEvent, CompanyCreatedEvent } from '../events/company-events';
import { VerificationSubmissionInProgressError, InvalidCompanyDataError } from './company-errors';
import { assertTransition, isFinal, type CompanyStatus } from './company-status';

export interface CompanyProps {
  id: string;
  name: string;
  registrationNumber: string | null;
  countryCode: string;
  status: CompanyStatus;
  verificationId: string | null;
  verificationSubmissionKey: string | null;
  submissionClaimedUntil: Date | null;
  decisionReasonCode: string | null;
  decidedAt: Date | null;
  createdBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type VerificationDecision = 'approved' | 'rejected';

export type VerificationResultOutcome =
  | { outcome: 'applied'; status: VerificationDecision; event?: CompanyApprovedEvent }
  | { outcome: 'ignored'; reason: string };

/**
 * Company aggregate. All status changes go through the state machine in company-status.ts.
 * Pure: no I/O, no framework; time and ids are passed in.
 */
export class Company {
  private constructor(private props: CompanyProps) {}

  static create(input: {
    id: string;
    name: string;
    registrationNumber?: string | null;
    countryCode: string;
    createdBy: string;
    now: Date;
  }): { company: Company; event: CompanyCreatedEvent } {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 200) {
      throw new InvalidCompanyDataError('Company name must be between 2 and 200 characters.');
    }
    if (!/^[A-Z]{2}$/.test(input.countryCode)) {
      throw new InvalidCompanyDataError('Country code must be an ISO 3166-1 alpha-2 code.');
    }
    const company = new Company({
      id: input.id,
      name,
      registrationNumber: input.registrationNumber?.trim() || null,
      countryCode: input.countryCode,
      status: 'draft',
      verificationId: null,
      verificationSubmissionKey: null,
      submissionClaimedUntil: null,
      decisionReasonCode: null,
      decidedAt: null,
      createdBy: input.createdBy,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return {
      company,
      event: {
        type: 'CompanyCreated',
        companyId: input.id,
        ownerUserId: input.createdBy,
        countryCode: input.countryCode,
      },
    };
  }

  static restore(props: CompanyProps): Company {
    return new Company({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get status(): CompanyStatus {
    return this.props.status;
  }
  get verificationId(): string | null {
    return this.props.verificationId;
  }
  get submissionKey(): string | null {
    return this.props.verificationSubmissionKey;
  }

  snapshot(): Readonly<CompanyProps> {
    return { ...this.props };
  }

  /**
   * Step 1 of requesting verification: only a draft company can be submitted. Reserves the submission
   * for a short time so concurrent requests cannot both call verification, and fixes the idempotency
   * key for this company's submission (reused on every retry, so a lost response is recovered).
   * The status stays draft until verification has actually accepted the request.
   */
  claimSubmission(now: Date, claimMs: number, newKey: () => string): string {
    assertTransition(this.props.status, 'pending');
    const claimedUntil = this.props.submissionClaimedUntil;
    if (claimedUntil && claimedUntil.getTime() > now.getTime()) {
      throw new VerificationSubmissionInProgressError();
    }
    const key = this.props.verificationSubmissionKey ?? newKey();
    this.touch(now, {
      verificationSubmissionKey: key,
      submissionClaimedUntil: new Date(now.getTime() + claimMs),
    });
    return key;
  }

  /** Releases the claim after a failed submission. The company stays draft; the key is kept for the retry. */
  releaseSubmission(now: Date): void {
    this.touch(now, { submissionClaimedUntil: null });
  }

  /** Step 2: verification accepted the request. draft → pending. Idempotent for the same verification id. */
  markSubmitted(verificationId: string, now: Date): void {
    if (this.props.verificationId === verificationId && this.props.status !== 'draft') {
      return;
    }
    assertTransition(this.props.status, 'pending');
    this.touch(now, { status: 'pending', verificationId, submissionClaimedUntil: null });
  }

  /**
   * Applies a verification.completed result.
   * - pending with the same verification id → approved | rejected.
   * - draft whose submission was in flight (the response to core was lost) → the event proves
   *   verification accepted it: draft → pending → decision.
   * - already final → ignored (duplicate or stale). A late `rejected` never undoes `approved`.
   * - draft never submitted → invalid transition (409).
   */
  applyVerificationResult(input: {
    verificationId: string;
    decision: VerificationDecision;
    reasonCode: string;
    now: Date;
  }): VerificationResultOutcome {
    const { status } = this.props;

    if (isFinal(status)) {
      if (this.props.verificationId === input.verificationId && status === input.decision) {
        return { outcome: 'ignored', reason: `already ${status}` };
      }
      return {
        outcome: 'ignored',
        reason: `stale: company is already ${status}; refusing to move it to ${input.decision}`,
      };
    }

    if (status === 'pending' && this.props.verificationId !== input.verificationId) {
      return { outcome: 'ignored', reason: 'result belongs to a different verification request' };
    }

    if (status === 'draft') {
      if (!this.props.verificationSubmissionKey) {
        assertTransition(status, input.decision); // throws: draft cannot be decided
      }
      this.markSubmitted(input.verificationId, input.now);
    }

    assertTransition(this.props.status, input.decision);
    this.touch(input.now, {
      status: input.decision,
      decisionReasonCode: input.reasonCode,
      decidedAt: input.now,
      submissionClaimedUntil: null,
    });
    if (input.decision === 'approved') {
      return {
        outcome: 'applied',
        status: 'approved',
        event: {
          type: 'CompanyApproved',
          companyId: this.props.id,
          verificationId: input.verificationId,
        },
      };
    }
    return { outcome: 'applied', status: 'rejected' };
  }

  private touch(now: Date, changes: Partial<CompanyProps>): void {
    this.props = { ...this.props, ...changes, updatedAt: now };
  }
}
