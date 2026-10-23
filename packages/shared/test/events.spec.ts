import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { assertPublishable, EventTypes, parseIncomingEvent } from '../src/events/contracts';
import { buildEnvelope, eventEnvelopeSchema, parseEventType } from '../src/events/envelope';
import { createContext, runWithContext } from '../src/tracing/context';

const companyId = uuidv7();
const completed = () =>
  buildEnvelope({
    eventType: EventTypes.VERIFICATION_COMPLETED,
    aggregateId: companyId,
    data: {
      verification_id: uuidv7(),
      company_id: companyId,
      decision: 'approved',
      reason_code: 'documents_valid',
    },
  });

describe('event types', () => {
  it('uses the exact required strings', () => {
    expect(EventTypes).toEqual({
      COMPANY_CREATED: 'dv.jo.core.company_created.v1',
      COMPANY_APPROVED: 'dv.jo.core.company_approved.v1',
      VERIFICATION_COMPLETED: 'dv.jo.verification.completed.v1',
    });
  });

  it('parses dv.<country>.<service>.<event>.v<n>', () => {
    expect(parseEventType('dv.jo.verification.completed.v1')).toEqual({
      country: 'jo',
      service: 'verification',
      event: 'completed',
      version: 1,
      contractKey: 'verification.completed.v1',
    });
    expect(parseEventType('verification.completed')).toBeUndefined();
    expect(parseEventType('dv.jo.verification.completed.v0')).toBeUndefined();
  });
});

describe('event envelope', () => {
  it('builds a valid envelope with a UUID v7 id', () => {
    const envelope = completed();
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.event_id[14]).toBe('7');
    expect(() => assertPublishable(envelope)).not.toThrow();
  });

  it('carries the current request id and trace into the event', () => {
    const context = createContext({
      requestId: 'req-12345678',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    const envelope = runWithContext(context, completed);
    expect(envelope.request_id).toBe('req-12345678');
    expect(envelope.traceparent.split('-')[1]).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('rejects a UUID v4 event id', () => {
    expect(eventEnvelopeSchema.safeParse({ ...completed(), event_id: uuidv4() }).success).toBe(
      false,
    );
  });

  it('rejects a schema_version that does not match the type version', () => {
    expect(eventEnvelopeSchema.safeParse({ ...completed(), schema_version: 2 }).success).toBe(
      false,
    );
  });

  it('rejects unknown envelope fields', () => {
    expect(eventEnvelopeSchema.safeParse({ ...completed(), extra: 1 }).success).toBe(false);
  });
});

describe('contract validation', () => {
  it('refuses to publish personal data in a payload', () => {
    const envelope = completed();
    expect(() =>
      assertPublishable({ ...envelope, data: { ...envelope.data, email: 'x@y.z' } }),
    ).toThrow();
  });

  it('parses a valid incoming event for an expected type', () => {
    const envelope = completed();
    expect(
      parseIncomingEvent(JSON.parse(JSON.stringify(envelope)), [EventTypes.VERIFICATION_COMPLETED])
        .event_id,
    ).toBe(envelope.event_id);
  });

  it.each([
    [
      'a type this consumer does not handle',
      (e: Record<string, unknown>) => e,
      [EventTypes.COMPANY_APPROVED],
      'EVENT_UNSUPPORTED_TYPE',
    ],
    [
      'a broken envelope',
      (e: Record<string, unknown>) => ({ ...e, event_id: 'nope' }),
      [EventTypes.VERIFICATION_COMPLETED],
      'EVENT_INVALID',
    ],
    [
      'a payload breaking its contract',
      (e: Record<string, unknown>) => ({ ...e, data: { decision: 'maybe' } }),
      [EventTypes.VERIFICATION_COMPLETED],
      'EVENT_INVALID',
    ],
  ])('rejects %s with 400', (_label, mutate, expected, code) => {
    const raw = mutate(JSON.parse(JSON.stringify(completed())) as Record<string, unknown>);
    expect(() => parseIncomingEvent(raw, expected)).toThrow(
      expect.objectContaining({ statusCode: 400, code }),
    );
  });
});
