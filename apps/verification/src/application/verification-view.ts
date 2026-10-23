import type { VerificationRequest } from '../domain/verification-request';

export interface VerificationView {
  id: string;
  company_id: string;
  status: string;
  decision_reason_code: string | null;
  decided_at: string | null;
  created_at: string;
}

export function toView(request: VerificationRequest): VerificationView {
  const s = request.snapshot();
  return {
    id: s.id,
    company_id: s.companyId,
    status: s.status,
    decision_reason_code: s.decisionReasonCode,
    decided_at: s.decidedAt?.toISOString() ?? null,
    created_at: s.createdAt.toISOString(),
  };
}
