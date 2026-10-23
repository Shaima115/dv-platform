/**
 * Application error carrying a stable, machine-readable code and the HTTP status it maps to.
 * Domain errors are converted into AppError at the application/API boundary.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = (code: string, message: string): AppError =>
  new AppError(401, code, message);

export const forbidden = (code: string, message: string): AppError =>
  new AppError(403, code, message);

export const notFound = (code: string, message: string): AppError =>
  new AppError(404, code, message);

export const conflict = (
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError => new AppError(409, code, message, details);

export const badRequest = (
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError => new AppError(400, code, message, details);

export const serviceUnavailable = (code: string, message: string): AppError =>
  new AppError(503, code, message);

/** Shared error codes used by the technical infrastructure. Business codes live in each service. */
export const ErrorCodes = {
  AUTH_MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_WRONG_TOKEN_KIND: 'AUTH_WRONG_TOKEN_KIND',
  AUTH_CALLER_NOT_ALLOWED: 'AUTH_CALLER_NOT_ALLOWED',
  AUTH_ENDPOINT_NOT_DECLARED: 'AUTH_ENDPOINT_NOT_DECLARED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  EVENT_INVALID: 'EVENT_INVALID',
  EVENT_UNSUPPORTED_TYPE: 'EVENT_UNSUPPORTED_TYPE',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
