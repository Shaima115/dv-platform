import CircuitBreaker from 'opossum';
import { DependencyUnavailableError, type Logger, type ServiceHttpClient } from '@dv/shared';
import {
  VerificationRefusedError,
  VerificationUnavailableError,
  type VerificationGateway,
  type VerificationSubmission,
} from '../../application/ports/verification-gateway';

export interface BreakerSettings {
  errorThresholdPercentage: number;
  volumeThreshold: number;
  rollingCountTimeout: number;
  resetTimeout: number;
}

interface CreatedVerification {
  id?: unknown;
}

/**
 * core → verification over the Nginx internal listener. The HTTP client owns timeout, retries and the
 * idempotency key; the circuit breaker wraps the whole logical call. When the breaker is open the call
 * fails immediately without touching the network.
 */
export class HttpVerificationGateway implements VerificationGateway {
  private readonly breaker: CircuitBreaker<
    [VerificationSubmission, string],
    { verificationId: string }
  >;

  constructor(
    private readonly client: ServiceHttpClient,
    settings: BreakerSettings,
    private readonly logger: Logger,
  ) {
    this.breaker = new CircuitBreaker(
      (submission: VerificationSubmission, key: string) => this.call(submission, key),
      {
        timeout: false, // the HTTP client enforces per-attempt timeouts and an overall deadline
        errorThresholdPercentage: settings.errorThresholdPercentage,
        volumeThreshold: settings.volumeThreshold,
        rollingCountTimeout: settings.rollingCountTimeout,
        resetTimeout: settings.resetTimeout,
        // Definitive refusals (4xx) mean verification is healthy; they must not open the circuit.
        errorFilter: (error: unknown) => error instanceof VerificationRefusedError,
      },
    );
    this.breaker.on('open', () =>
      this.logger.error(
        { operation: 'circuit', circuit: 'verification', circuit_state: 'open' },
        'circuit opened',
      ),
    );
    this.breaker.on('halfOpen', () =>
      this.logger.warn(
        { operation: 'circuit', circuit: 'verification', circuit_state: 'half_open' },
        'circuit half-open',
      ),
    );
    this.breaker.on('close', () =>
      this.logger.info(
        { operation: 'circuit', circuit: 'verification', circuit_state: 'closed' },
        'circuit closed',
      ),
    );
  }

  get circuitState(): 'open' | 'half_open' | 'closed' {
    if (this.breaker.opened) return 'open';
    if (this.breaker.halfOpen) return 'half_open';
    return 'closed';
  }

  async submit(
    submission: VerificationSubmission,
    idempotencyKey: string,
  ): Promise<{ verificationId: string }> {
    try {
      return await this.breaker.fire(submission, idempotencyKey);
    } catch (error) {
      if (error instanceof VerificationRefusedError) throw error;
      if ((error as { code?: string }).code === 'EOPENBREAKER') {
        throw new VerificationUnavailableError('verification circuit is open', true);
      }
      throw new VerificationUnavailableError((error as Error).message, false);
    }
  }

  private async call(
    submission: VerificationSubmission,
    key: string,
  ): Promise<{ verificationId: string }> {
    const response = await this.client.postJson<CreatedVerification & { code?: string }>(
      '/internal/v1/verifications',
      { company_id: submission.companyId, requested_by_subject: submission.requestedBySubject },
      key,
    );
    if (
      (response.status === 200 || response.status === 201) &&
      typeof response.body?.id === 'string'
    ) {
      return { verificationId: response.body.id };
    }
    if (response.status === 409 || response.status === 400 || response.status === 422) {
      throw new VerificationRefusedError(response.status, String(response.body?.code ?? 'UNKNOWN'));
    }
    // 401/403/404/5xx here mean misconfiguration or an unhealthy dependency.
    throw new DependencyUnavailableError(
      `verification answered ${response.status}`,
      response.attempts,
      response.status,
    );
  }
}
