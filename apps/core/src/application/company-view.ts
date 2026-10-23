import type { Company } from '../domain/company/company';
import type { CompanyRole } from '../domain/company/company-role';

export interface CompanyView {
  id: string;
  name: string;
  registrationNumber: string | null;
  countryCode: string;
  status: string;
  verificationId: string | null;
  decisionReasonCode: string | null;
  decidedAt: string | null;
  myRole: CompanyRole;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toCompanyView(company: Company, myRole: CompanyRole): CompanyView {
  const s = company.snapshot();
  return {
    id: s.id,
    name: s.name,
    registrationNumber: s.registrationNumber,
    countryCode: s.countryCode,
    status: s.status,
    verificationId: s.verificationId,
    decisionReasonCode: s.decisionReasonCode,
    decidedAt: s.decidedAt?.toISOString() ?? null,
    myRole,
    version: s.version,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
