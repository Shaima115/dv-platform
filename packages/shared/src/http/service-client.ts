import type { Logger } from 'pino';
import type { ServiceTokenSource } from '../auth/token-provider';
import { outgoingTraceHeaders } from '../tracing/context';

export interface RetryPolicy {
  /** Per-attempt timeout. */
  attemptTimeoutMs: number;
  /** Retries after the first attempt. */
  maxRetries: number;
  backoffBaseMs: number;
  /** Hard ceiling for the whole call including backoff, so the public endpoint never hangs. */
  overallDeadlineMs: number;
}

export interface ServiceResponse<T = unknown> {
  status: number;
  body: T;
  attempts: number;
}

/** The dependency could not be reached or kept failing transiently. Maps to 503 upstream. */
export class DependencyUnavailableError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastStatus?: number,
  ) {
    super(message);
    this.name = 'DependencyUnavailableError';
  }
}

/** Statuses worth retrying: the gateway or upstream had a transient problem. 4xx never retried. */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Internal REST client: service token, request id and traceparent on every call, per-attempt timeout,
 * bounded retries with exponential backoff and jitter, the SAME idempotency key on every retry, and an
 * overall deadline. Retries only network errors, timeouts and 502/503/504.
 */
export class ServiceHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: ServiceTokenSource,
    private readonly policy: RetryPolicy,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async postJson<T>(
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<ServiceResponse<T>> {
    const url = new URL(path, this.baseUrl).toString();
    const deadline = Date.now() + this.policy.overallDeadlineMs;
    const traceHeaders = outgoingTraceHeaders();
    let lastError = 'no attempt made';
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= this.policy.maxRetries + 1; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const fields = {
        operation: 'service_call',
        target: url,
        attempt,
        idempotency_key: idempotencyKey,
      };

      let token: string;
      try {
        token = await this.tokens.getToken();
      } catch (error) {
        throw new DependencyUnavailableError(
          `could not obtain a service token: ${(error as Error).message}`,
          attempt,
        );
      }

      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'idempotency-key': idempotencyKey,
            ...traceHeaders,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(this.policy.attemptTimeoutMs, remaining)),
        });
        const text = await response.text();
        const parsed: unknown = text.length > 0 ? safeJson(text) : undefined;
        if (!RETRYABLE_STATUS.has(response.status)) {
          if (response.status === 401) this.tokens.invalidate();
          this.logger.info({ ...fields, status_code: response.status }, 'service call completed');
          return { status: response.status, body: parsed as T, attempts: attempt };
        }
        lastStatus = response.status;
        lastError = `upstream answered ${response.status}`;
      } catch (error) {
        lastStatus = undefined;
        lastError =
          (error as Error).name === 'TimeoutError' ? 'attempt timed out' : (error as Error).message;
      }

      const isLast = attempt === this.policy.maxRetries + 1;
      this.logger.warn(
        { ...fields, status_code: lastStatus, error_message: lastError },
        'service call attempt failed',
      );
      if (isLast) break;
      const delay = Math.round(
        this.policy.backoffBaseMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4),
      );
      if (Date.now() + delay >= deadline) break;
      await sleep(delay);
    }
    throw new DependencyUnavailableError(lastError, this.policy.maxRetries + 1, lastStatus);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}
