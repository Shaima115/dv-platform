import { AppError } from '@dv/shared';
import {
  VerificationRefusedError,
  VerificationUnavailableError,
} from '../application/ports/verification-gateway';
import { DomainError, type DomainErrorCategory } from '../domain/shared/domain-error';

const STATUS: Record<DomainErrorCategory, number> = {
  conflict: 409,
  not_found: 404,
  forbidden: 403,
  invalid: 400,
};

/** Translates domain and gateway errors into the HTTP error contract. */
export function mapCoreError(error: unknown): AppError | undefined {
  if (error instanceof DomainError) {
    return new AppError(STATUS[error.category], error.code, error.message, error.details);
  }
  if (error instanceof VerificationUnavailableError) {
    return error.circuitOpen
      ? new AppError(
          503,
          'VERIFICATION_CIRCUIT_OPEN',
          'Verification is temporarily unavailable. The company stays in draft; try again later.',
        )
      : new AppError(
          503,
          'VERIFICATION_UNAVAILABLE',
          'Verification did not respond. The company stays in draft; try again later.',
        );
  }
  if (error instanceof VerificationRefusedError) {
    return new AppError(
      409,
      `VERIFICATION_${error.code}`.replace(/^VERIFICATION_VERIFICATION_/, 'VERIFICATION_'),
      'Verification refused the request.',
    );
  }
  return undefined;
}
