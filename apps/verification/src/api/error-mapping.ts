import { AppError } from '@dv/shared';
import { VerificationDomainError } from '../domain/verification-request';

const STATUS = { conflict: 409, not_found: 404, forbidden: 403, invalid: 400 } as const;

export function mapVerificationError(error: unknown): AppError | undefined {
  if (error instanceof VerificationDomainError) {
    return new AppError(STATUS[error.category], error.code, error.message);
  }
  return undefined;
}
