import { DomainError } from '../shared/domain-error';

export class CompanyNotFoundError extends DomainError {
  readonly code = 'COMPANY_NOT_FOUND';
  readonly category = 'not_found' as const;
  constructor() {
    super('The company does not exist or is not visible to you.');
  }
}

export class VerificationSubmissionInProgressError extends DomainError {
  readonly code = 'COMPANY_VERIFICATION_SUBMISSION_IN_PROGRESS';
  readonly category = 'conflict' as const;
  constructor() {
    super('A verification request for this company is already being submitted.');
  }
}

export class InvalidCompanyDataError extends DomainError {
  readonly code = 'COMPANY_INVALID_DATA';
  readonly category = 'invalid' as const;
  constructor(message: string) {
    super(message);
  }
}

export class MemberAlreadyExistsError extends DomainError {
  readonly code = 'COMPANY_MEMBER_ALREADY_EXISTS';
  readonly category = 'conflict' as const;
  constructor() {
    super('This user is already a member of the company.');
  }
}

export class UserAccountNotFoundError extends DomainError {
  readonly code = 'USER_ACCOUNT_NOT_FOUND';
  readonly category = 'not_found' as const;
  constructor() {
    super('The user account does not exist.');
  }
}
