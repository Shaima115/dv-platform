/** Outbound port: start a verification in the verification service (the only synchronous call). */
export interface VerificationSubmission {
  companyId: string;
  requestedBySubject: string;
}

export interface VerificationGateway {
  /**
   * Submits the request with the given idempotency key. Resolves with the verification id.
   * Rejects with VerificationUnavailableError when the dependency is down or the circuit is open.
   */
  submit(
    submission: VerificationSubmission,
    idempotencyKey: string,
  ): Promise<{ verificationId: string }>;
}

export class VerificationUnavailableError extends Error {
  constructor(
    message: string,
    public readonly circuitOpen: boolean,
  ) {
    super(message);
    this.name = 'VerificationUnavailableError';
  }
}

/** Verification answered with a definitive refusal (e.g. a request is already open for the company). */
export class VerificationRefusedError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`verification refused the request (${status} ${code})`);
    this.name = 'VerificationRefusedError';
  }
}

export const VERIFICATION_GATEWAY = Symbol('VERIFICATION_GATEWAY');
