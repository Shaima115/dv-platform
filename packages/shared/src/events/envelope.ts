import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from 'uuid';
import { z } from 'zod';
import { currentContext, formatTraceparent, newSpanId, newTraceId } from '../tracing/context';

/** dv.<country>.<service>.<event>.v<n>, e.g. dv.jo.verification.completed.v1 */
export const EVENT_TYPE_RE =
  /^dv\.([a-z]{2})\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\.v([1-9][0-9]*)$/;

export interface ParsedEventType {
  country: string;
  service: string;
  event: string;
  version: number;
  /** Country-independent key used by the schema registry, e.g. verification.completed.v1 */
  contractKey: string;
}

export function parseEventType(eventType: string): ParsedEventType | undefined {
  const match = EVENT_TYPE_RE.exec(eventType);
  if (!match) return undefined;
  const [, country, service, event, version] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    country,
    service,
    event,
    version: Number(version),
    contractKey: `${service}.${event}.v${version}`,
  };
}

export function eventType(
  country: string,
  service: string,
  event: string,
  version: number,
): string {
  const value = `dv.${country}.${service}.${event}.v${version}`;
  if (!EVENT_TYPE_RE.test(value)) throw new Error(`Invalid event type: ${value}`);
  return value;
}

export const isUuidV7 = (value: string): boolean => uuidValidate(value) && uuidVersion(value) === 7;

/** The envelope every event carries. `data` holds IDs and codes only — never personal data. */
export const eventEnvelopeSchema = z
  .object({
    event_id: z.string().refine(isUuidV7, 'event_id must be a UUID v7'),
    event_type: z
      .string()
      .regex(EVENT_TYPE_RE, 'event_type must follow dv.<country>.<service>.<event>.v<n>'),
    schema_version: z.number().int().positive(),
    occurred_at: z.string().datetime({ offset: true }),
    country: z.string().regex(/^[a-z]{2}$/),
    aggregate_id: z.string().uuid(),
    request_id: z.string().min(1).max(128),
    traceparent: z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
    data: z.record(z.unknown()),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const parsed = parseEventType(envelope.event_type);
    if (parsed && parsed.version !== envelope.schema_version) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'schema_version must match the event_type version',
        path: ['schema_version'],
      });
    }
    if (parsed && parsed.country !== envelope.country) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'country must match the event_type country',
        path: ['country'],
      });
    }
  });

export type EventEnvelope<TData = Record<string, unknown>> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  'data'
> & {
  data: TData;
};

/**
 * Builds an envelope for a new event. request_id and traceparent come from the current context so
 * the consumer continues the same trace; outside a request a fresh trace is started.
 */
export function buildEnvelope<TData extends Record<string, unknown>>(input: {
  eventType: string;
  aggregateId: string;
  data: TData;
  occurredAt?: Date;
}): EventEnvelope<TData> {
  const parsed = parseEventType(input.eventType);
  if (!parsed) throw new Error(`Invalid event type: ${input.eventType}`);
  const context = currentContext();
  return {
    event_id: uuidv7(),
    event_type: input.eventType,
    schema_version: parsed.version,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    country: parsed.country,
    aggregate_id: input.aggregateId,
    request_id: context?.requestId ?? uuidv7(),
    traceparent: context
      ? formatTraceparent(context.traceId, newSpanId())
      : formatTraceparent(newTraceId(), newSpanId()),
    data: input.data,
  };
}
