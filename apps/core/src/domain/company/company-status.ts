import { DomainError } from '../shared/domain-error';

export type CompanyStatus = 'draft' | 'pending' | 'approved' | 'rejected';

/**
 * The company state machine: draft → pending → approved | rejected.
 * approved and rejected are final. This table is the single source of truth for legal moves.
 */
export const COMPANY_TRANSITIONS: Readonly<Record<CompanyStatus, readonly CompanyStatus[]>> = {
  draft: ['pending'],
  pending: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

export class InvalidCompanyTransitionError extends DomainError {
  readonly code = 'COMPANY_INVALID_STATE_TRANSITION';
  readonly category = 'conflict' as const;
  constructor(from: CompanyStatus, to: CompanyStatus) {
    super(`A company cannot move from ${from} to ${to}.`, { from, to });
  }
}

export function canTransition(from: CompanyStatus, to: CompanyStatus): boolean {
  return COMPANY_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CompanyStatus, to: CompanyStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidCompanyTransitionError(from, to);
  }
}

export const isFinal = (status: CompanyStatus): boolean => COMPANY_TRANSITIONS[status].length === 0;
