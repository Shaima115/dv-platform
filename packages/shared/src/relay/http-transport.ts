import type { ServiceTokenSource } from '../auth/token-provider';
import type { EventEnvelope } from '../events/envelope';
import { newSpanId, parseTraceparent, formatTraceparent } from '../tracing/context';

export type DeliveryResult =
  { ok: true; statusCode: number } | { ok: false; statusCode?: number; error: string };

/**
 * How a relay moves one event to one subscriber. HTTP today; a broker adapter could implement the
 * same interface without touching producers or the domain.
 */
export interface DeliveryTransport {
  deliver(targetUrl: string, envelope: EventEnvelope): Promise<DeliveryResult>;
}

/** POSTs the envelope with the producer's service token, request id and a child span of the event's trace. */
export class HttpDeliveryTransport implements DeliveryTransport {
  constructor(
    private readonly tokens: ServiceTokenSource,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async deliver(targetUrl: string, envelope: EventEnvelope): Promise<DeliveryResult> {
    let token: string;
    try {
      token = await this.tokens.getToken();
    } catch (error) {
      return { ok: false, error: `service token unavailable: ${(error as Error).message}` };
    }
    const parent = parseTraceparent(envelope.traceparent);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-request-id': envelope.request_id,
      'x-event-id': envelope.event_id,
    };
    if (parent) headers.traceparent = formatTraceparent(parent.traceId, newSpanId(), parent.flags);

    try {
      const response = await this.fetchImpl(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Drain the body so the connection can be reused; content is not needed.
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 401) this.tokens.invalidate();
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, statusCode: response.status };
      }
      return {
        ok: false,
        statusCode: response.status,
        error: `subscriber answered ${response.status}`,
      };
    } catch (error) {
      const name = (error as Error).name;
      return {
        ok: false,
        error:
          name === 'TimeoutError'
            ? `timed out after ${this.timeoutMs}ms`
            : (error as Error).message,
      };
    }
  }
}
