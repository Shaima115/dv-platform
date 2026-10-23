import { DomainError } from '../shared/domain-error';

export class ForbiddenActionError extends DomainError {
  readonly code = 'FORBIDDEN_ACTION';
  readonly category = 'forbidden' as const;
  constructor(action: string, reason: string) {
    super('You are not allowed to perform this action.', { action, reason });
  }
}
