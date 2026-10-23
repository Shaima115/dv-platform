import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Per-request (or per-event) context carried through async calls.
 * Every log line, outgoing request and event envelope reads from here.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly traceId: string;
  /** Span id of the current unit of work (this service's span). */
  readonly spanId: string;
  /** W3C traceparent header value representing the current span. */
  readonly traceparent: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

export interface ParsedTraceparent {
  traceId: string;
  parentSpanId: string;
  flags: string;
}

/** Parses a W3C traceparent (version 00). Returns undefined for anything malformed or all-zero. */
export function parseTraceparent(value: string | undefined | null): ParsedTraceparent | undefined {
  if (!value) return undefined;
  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const [, traceId, parentSpanId, flags] = match as unknown as [string, string, string, string];
  if (traceId === ZERO_TRACE || parentSpanId === ZERO_SPAN) return undefined;
  return { traceId, parentSpanId, flags };
}

export const newTraceId = (): string => randomBytes(16).toString('hex');
export const newSpanId = (): string => randomBytes(8).toString('hex');
export const formatTraceparent = (traceId: string, spanId: string, flags = '01'): string =>
  `00-${traceId}-${spanId}-${flags}`;

/** Accepts a caller-supplied request id only when it is a safe token; otherwise generates one. */
export function sanitizeRequestId(value: string | undefined | null): string {
  if (value && REQUEST_ID_RE.test(value)) return value;
  return randomUUID();
}

/**
 * Builds the context for an incoming unit of work: continues the caller's trace when the
 * traceparent is valid, otherwise starts a new trace. Always creates a new span for this service.
 */
export function createContext(input: {
  requestId?: string | null;
  traceparent?: string | null;
}): RequestContext {
  const parent = parseTraceparent(input.traceparent);
  const traceId = parent?.traceId ?? newTraceId();
  const spanId = newSpanId();
  return {
    requestId: sanitizeRequestId(input.requestId),
    traceId,
    spanId,
    traceparent: formatTraceparent(traceId, spanId, parent?.flags ?? '01'),
  };
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Headers to propagate on an outgoing call: same request id and trace, a fresh child span. */
export function outgoingTraceHeaders(): Record<string, string> {
  const context = currentContext();
  if (!context) return {};
  return {
    'x-request-id': context.requestId,
    traceparent: formatTraceparent(context.traceId, newSpanId()),
  };
}
