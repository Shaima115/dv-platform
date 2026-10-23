/**
 * Base class for business-rule violations. Carries a stable code; the API layer maps the category to
 * an HTTP status. The domain knows nothing about HTTP.
 */
export type DomainErrorCategory = 'conflict' | 'not_found' | 'forbidden' | 'invalid';

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly category: DomainErrorCategory;
  readonly details?: Readonly<Record<string, unknown>>;

  protected constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}
