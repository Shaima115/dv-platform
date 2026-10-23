import { Company, type CompanyProps } from '../src/domain/company/company';
import { VerificationSubmissionInProgressError } from '../src/domain/company/company-errors';
import {
  canTransition,
  COMPANY_TRANSITIONS,
  InvalidCompanyTransitionError,
  type CompanyStatus,
} from '../src/domain/company/company-status';

const NOW = new Date('2026-10-17T10:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const STATUSES: CompanyStatus[] = ['draft', 'pending', 'approved', 'rejected'];

function company(overrides: Partial<CompanyProps> = {}): Company {
  return Company.restore({
    id: '01a14e5d-0000-7000-8000-000000000001',
    name: 'Acme',
    registrationNumber: null,
    countryCode: 'JO',
    status: 'draft',
    verificationId: null,
    verificationSubmissionKey: null,
    submissionClaimedUntil: null,
    decisionReasonCode: null,
    decidedAt: null,
    createdBy: '01a14e5d-0000-7000-8000-0000000000aa',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('company state machine table', () => {
  const allowed = new Set(['draft>pending', 'pending>approved', 'pending>rejected']);
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const legal = allowed.has(`${from}>${to}`);
      it(`${from} → ${to} is ${legal ? 'allowed' : 'refused'}`, () => {
        expect(canTransition(from, to)).toBe(legal);
      });
    }
  }

  it('approved and rejected are final', () => {
    expect(COMPANY_TRANSITIONS.approved).toEqual([]);
    expect(COMPANY_TRANSITIONS.rejected).toEqual([]);
  });

  it('invalid transitions carry a stable error code and the attempted move', () => {
    const error = new InvalidCompanyTransitionError('approved', 'rejected');
    expect(error.code).toBe('COMPANY_INVALID_STATE_TRANSITION');
    expect(error.category).toBe('conflict');
    expect(error.details).toEqual({ from: 'approved', to: 'rejected' });
  });
});

describe('Company.create', () => {
  it('starts in draft and raises CompanyCreated', () => {
    const { company: c, event } = Company.create({
      id: 'c1',
      name: '  Acme  ',
      countryCode: 'JO',
      createdBy: 'u1',
      now: NOW,
    });
    expect(c.status).toBe('draft');
    expect(c.snapshot().name).toBe('Acme');
    expect(event).toEqual({
      type: 'CompanyCreated',
      companyId: 'c1',
      ownerUserId: 'u1',
      countryCode: 'JO',
    });
  });

  it.each([['A'], ['x'.repeat(201)]])('rejects an invalid name %#', (name) => {
    expect(() =>
      Company.create({ id: 'c1', name, countryCode: 'JO', createdBy: 'u1', now: NOW }),
    ).toThrow('Company name');
  });

  it('rejects an invalid country code', () => {
    expect(() =>
      Company.create({ id: 'c1', name: 'Acme', countryCode: 'jo', createdBy: 'u1', now: NOW }),
    ).toThrow('Country code');
  });
});

describe('requesting verification', () => {
  it('claims a draft company with a stable key and stays draft', () => {
    const c = company();
    const key = c.claimSubmission(NOW, 10_000, () => 'key-1');
    expect(key).toBe('key-1');
    expect(c.status).toBe('draft');
    expect(c.snapshot().submissionClaimedUntil).toEqual(later(10_000));
  });

  it('refuses a second claim while the first is active', () => {
    const c = company();
    c.claimSubmission(NOW, 10_000, () => 'key-1');
    expect(() => c.claimSubmission(later(1), 10_000, () => 'key-2')).toThrow(
      VerificationSubmissionInProgressError,
    );
  });

  it('reuses the same idempotency key after a failed attempt', () => {
    const c = company();
    c.claimSubmission(NOW, 10_000, () => 'key-1');
    c.releaseSubmission(later(10));
    expect(c.claimSubmission(later(20), 10_000, () => 'key-2')).toBe('key-1');
  });

  it('reuses the key once an abandoned claim has expired', () => {
    const c = company();
    c.claimSubmission(NOW, 10_000, () => 'key-1');
    expect(c.claimSubmission(later(10_001), 10_000, () => 'key-2')).toBe('key-1');
  });

  it.each(['pending', 'approved', 'rejected'] as const)(
    'refuses to submit a %s company with 409',
    (status) => {
      const c = company({ status, verificationId: 'v1' });
      expect(() => c.claimSubmission(NOW, 10_000, () => 'k')).toThrow(
        InvalidCompanyTransitionError,
      );
    },
  );

  it('moves draft → pending once verification accepted, idempotently', () => {
    const c = company({ verificationSubmissionKey: 'k' });
    c.markSubmitted('v1', NOW);
    expect(c.status).toBe('pending');
    expect(c.verificationId).toBe('v1');
    c.markSubmitted('v1', later(1));
    expect(c.status).toBe('pending');
  });
});

describe('applying verification results', () => {
  const result = (decision: 'approved' | 'rejected', verificationId = 'v1') => ({
    verificationId,
    decision,
    reasonCode: 'documents_valid',
    now: later(5),
  });

  it('pending → approved raises CompanyApproved', () => {
    const c = company({ status: 'pending', verificationId: 'v1' });
    const outcome = c.applyVerificationResult(result('approved'));
    expect(outcome).toEqual({
      outcome: 'applied',
      status: 'approved',
      event: { type: 'CompanyApproved', companyId: c.id, verificationId: 'v1' },
    });
    expect(c.status).toBe('approved');
    expect(c.snapshot().decidedAt).toEqual(later(5));
  });

  it('pending → rejected raises no approval event', () => {
    const c = company({ status: 'pending', verificationId: 'v1' });
    expect(c.applyVerificationResult(result('rejected'))).toEqual({
      outcome: 'applied',
      status: 'rejected',
    });
    expect(c.status).toBe('rejected');
  });

  it('ignores a late rejection after approval (never moves backwards)', () => {
    const c = company({ status: 'approved', verificationId: 'v1' });
    const outcome = c.applyVerificationResult(result('rejected'));
    expect(outcome.outcome).toBe('ignored');
    expect(c.status).toBe('approved');
  });

  it('ignores a late approval after rejection', () => {
    const c = company({ status: 'rejected', verificationId: 'v1' });
    expect(c.applyVerificationResult(result('approved')).outcome).toBe('ignored');
    expect(c.status).toBe('rejected');
  });

  it('treats a repeated identical result as already applied', () => {
    const c = company({ status: 'approved', verificationId: 'v1' });
    expect(c.applyVerificationResult(result('approved'))).toEqual({
      outcome: 'ignored',
      reason: 'already approved',
    });
  });

  it('ignores a result for a different verification request', () => {
    const c = company({ status: 'pending', verificationId: 'v1' });
    expect(c.applyVerificationResult(result('approved', 'v2')).outcome).toBe('ignored');
    expect(c.status).toBe('pending');
  });

  it('refuses to decide a draft company that was never submitted (409)', () => {
    const c = company();
    expect(() => c.applyVerificationResult(result('approved'))).toThrow(
      InvalidCompanyTransitionError,
    );
    expect(c.status).toBe('draft');
  });

  it('confirms an in-flight submission whose response was lost, then applies the decision', () => {
    const c = company({ verificationSubmissionKey: 'k', submissionClaimedUntil: later(10_000) });
    const outcome = c.applyVerificationResult(result('approved'));
    expect(outcome.outcome).toBe('applied');
    expect(c.status).toBe('approved');
    expect(c.verificationId).toBe('v1');
  });
});
