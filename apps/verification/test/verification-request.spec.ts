import { mayPerform } from '../src/domain/policy';
import { VerificationDomainError, VerificationRequest } from '../src/domain/verification-request';

const NOW = new Date('2026-10-17T10:00:00Z');
const open = () =>
  VerificationRequest.open({
    id: 'v1',
    companyId: 'c1',
    requestedByClient: 'svc-core',
    requestedBySubject: 's1',
    idempotencyKey: 'key-0001',
    requestFingerprint: 'f'.repeat(64),
    createdAt: NOW,
  });
const decision = (d: 'approved' | 'rejected') => ({
  decision: d,
  reasonCode: 'documents_valid',
  comment: null,
  reviewerSubject: 'r1',
  now: NOW,
});

describe('VerificationRequest', () => {
  it('opens as pending', () => {
    expect(open().snapshot().status).toBe('pending');
  });

  it.each(['approved', 'rejected'] as const)(
    'pending → %s records the reviewer and reason',
    (d) => {
      const request = open();
      request.decide(decision(d));
      expect(request.snapshot()).toMatchObject({
        status: d,
        decidedBySubject: 'r1',
        decisionReasonCode: 'documents_valid',
        decidedAt: NOW,
      });
    },
  );

  it('refuses a second decision with VERIFICATION_ALREADY_DECIDED', () => {
    const request = open();
    request.decide(decision('approved'));
    try {
      request.decide(decision('rejected'));
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationDomainError);
      expect((error as VerificationDomainError).code).toBe('VERIFICATION_ALREADY_DECIDED');
      expect((error as VerificationDomainError).category).toBe('conflict');
    }
    expect(request.snapshot().status).toBe('approved');
  });
});

describe('verification policy', () => {
  it('only users with the reviewer realm role may decide', () => {
    expect(
      mayPerform('verification:decide', { kind: 'user', platformRoles: new Set(['reviewer']) }),
    ).toBe(true);
    expect(
      mayPerform('verification:decide', { kind: 'user', platformRoles: new Set(['admin']) }),
    ).toBe(false);
    expect(mayPerform('verification:decide', { kind: 'user', platformRoles: new Set() })).toBe(
      false,
    );
    expect(
      mayPerform('verification:decide', { kind: 'service', platformRoles: new Set(['reviewer']) }),
    ).toBe(false);
  });
});
