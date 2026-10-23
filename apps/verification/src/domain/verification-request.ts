/** Verification request aggregate: pending → approved | rejected, decided once. Pure, no I/O. */
export type VerificationStatus = 'pending' | 'approved' | 'rejected';
export type Decision = 'approved' | 'rejected';

export class VerificationDomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly category: 'conflict' | 'not_found' | 'forbidden' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'VerificationDomainError';
  }
}

export const alreadyDecided = (status: VerificationStatus) =>
  new VerificationDomainError(
    'VERIFICATION_ALREADY_DECIDED',
    'conflict',
    `This verification request is already ${status}.`,
  );
export const requestNotFound = () =>
  new VerificationDomainError(
    'VERIFICATION_NOT_FOUND',
    'not_found',
    'The verification request does not exist.',
  );
export const notAReviewer = () =>
  new VerificationDomainError(
    'FORBIDDEN_ACTION',
    'forbidden',
    'Only reviewers may decide verification requests.',
  );

export interface VerificationRequestProps {
  id: string;
  companyId: string;
  requestedByClient: string;
  requestedBySubject: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: VerificationStatus;
  decisionReasonCode: string | null;
  decisionComment: string | null;
  decidedBySubject: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class VerificationRequest {
  private constructor(private props: VerificationRequestProps) {}

  static open(
    input: Omit<
      VerificationRequestProps,
      | 'status'
      | 'decisionReasonCode'
      | 'decisionComment'
      | 'decidedBySubject'
      | 'decidedAt'
      | 'updatedAt'
    >,
  ): VerificationRequest {
    return new VerificationRequest({
      ...input,
      status: 'pending',
      decisionReasonCode: null,
      decisionComment: null,
      decidedBySubject: null,
      decidedAt: null,
      updatedAt: input.createdAt,
    });
  }

  static restore(props: VerificationRequestProps): VerificationRequest {
    return new VerificationRequest({ ...props });
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): Readonly<VerificationRequestProps> {
    return { ...this.props };
  }

  decide(input: {
    decision: Decision;
    reasonCode: string;
    comment: string | null;
    reviewerSubject: string;
    now: Date;
  }): void {
    if (this.props.status !== 'pending') {
      throw alreadyDecided(this.props.status);
    }
    this.props = {
      ...this.props,
      status: input.decision,
      decisionReasonCode: input.reasonCode,
      decisionComment: input.comment,
      decidedBySubject: input.reviewerSubject,
      decidedAt: input.now,
      updatedAt: input.now,
    };
  }
}
