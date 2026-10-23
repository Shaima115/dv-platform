import { z, type ZodType } from 'zod';
import { badRequest, ErrorCodes } from '../errors/app-error';
import { eventEnvelopeSchema, eventType, parseEventType, type EventEnvelope } from './envelope';

/**
 * Integration contracts shared by producers and consumers, keyed by `<service>.<event>.v<n>`.
 * Producers validate before writing to the outbox; consumers validate every incoming event.
 * Payloads carry identifiers and codes only.
 */
export const companyCreatedV1 = z
  .object({
    company_id: z.string().uuid(),
    owner_user_id: z.string().uuid(),
    country_code: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();

export const companyApprovedV1 = z
  .object({
    company_id: z.string().uuid(),
    verification_id: z.string().uuid(),
    /** Keycloak subject of the company owner: the notification recipient. An id, not personal data. */
    owner_subject: z.string().min(1).max(64),
  })
  .strict();

export const verificationCompletedV1 = z
  .object({
    verification_id: z.string().uuid(),
    company_id: z.string().uuid(),
    decision: z.enum(['approved', 'rejected']),
    reason_code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  })
  .strict();

export type CompanyCreatedV1 = z.infer<typeof companyCreatedV1>;
export type CompanyApprovedV1 = z.infer<typeof companyApprovedV1>;
export type VerificationCompletedV1 = z.infer<typeof verificationCompletedV1>;

const registry: ReadonlyMap<string, ZodType> = new Map<string, ZodType>([
  ['core.company_created.v1', companyCreatedV1],
  ['core.company_approved.v1', companyApprovedV1],
  ['verification.completed.v1', verificationCompletedV1],
]);

export const COUNTRY = 'jo';

/** The exact event types used in this deployment. */
export const EventTypes = {
  COMPANY_CREATED: eventType(COUNTRY, 'core', 'company_created', 1),
  COMPANY_APPROVED: eventType(COUNTRY, 'core', 'company_approved', 1),
  VERIFICATION_COMPLETED: eventType(COUNTRY, 'verification', 'completed', 1),
} as const;

export function isKnownContract(type: string): boolean {
  const parsed = parseEventType(type);
  return parsed !== undefined && registry.has(parsed.contractKey);
}

/** Validates the payload of an event this service is about to publish. Throws on a contract breach. */
export function assertPublishable(envelope: EventEnvelope): void {
  eventEnvelopeSchema.parse(envelope);
  const parsed = parseEventType(envelope.event_type);
  const schema = parsed ? registry.get(parsed.contractKey) : undefined;
  if (!schema) throw new Error(`No contract registered for ${envelope.event_type}`);
  schema.parse(envelope.data);
}

/**
 * Parses an untrusted incoming event: envelope first, then the payload contract for its type and
 * version. Throws a 400 AppError with a stable code on any problem.
 */
export function parseIncomingEvent<T>(
  raw: unknown,
  expectedTypes: readonly string[],
): EventEnvelope<T> {
  const envelope = eventEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw badRequest(ErrorCodes.EVENT_INVALID, 'The event envelope is invalid.', {
      issues: envelope.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  if (!expectedTypes.includes(envelope.data.event_type)) {
    throw badRequest(
      ErrorCodes.EVENT_UNSUPPORTED_TYPE,
      'This consumer does not handle the event type.',
      {
        event_type: envelope.data.event_type,
      },
    );
  }
  const parsed = parseEventType(envelope.data.event_type);
  const schema = parsed ? registry.get(parsed.contractKey) : undefined;
  if (!schema) {
    throw badRequest(
      ErrorCodes.EVENT_UNSUPPORTED_TYPE,
      'No contract is registered for the event type.',
    );
  }
  const data = schema.safeParse(envelope.data.data);
  if (!data.success) {
    throw badRequest(ErrorCodes.EVENT_INVALID, 'The event payload does not match its contract.', {
      issues: data.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return { ...envelope.data, data: data.data as T };
}
