import type { Transaction } from '@dv/shared';
import type { Company } from '../../domain/company/company';
import type { CompanyRole } from '../../domain/company/company-role';

export interface UserAccount {
  id: string;
  keycloakSub: string;
}

export interface UserAccountRepository {
  /** Returns the account for a Keycloak subject, creating it race-safely the first time it is seen. */
  ensure(tx: Transaction, keycloakSub: string): Promise<UserAccount>;
  findById(tx: Transaction, id: string): Promise<UserAccount | null>;
}

export interface CompanySummary {
  id: string;
  name: string;
  countryCode: string;
  status: string;
  role: CompanyRole;
  createdAt: Date;
}

export interface CompanyRepository {
  insert(tx: Transaction, company: Company): Promise<void>;
  /** Loads and row-locks the company (SELECT … FOR UPDATE) for the rest of the transaction. */
  findForUpdate(tx: Transaction, id: string): Promise<Company | null>;
  findById(tx: Transaction, id: string): Promise<Company | null>;
  /** Persists changes; bumps the version column. */
  save(tx: Transaction, company: Company): Promise<void>;
  listForMember(
    tx: Transaction,
    userAccountId: string,
    page: Page,
  ): Promise<{ items: CompanySummary[]; total: number }>;
}

export interface MembershipRepository {
  add(
    tx: Transaction,
    companyId: string,
    userAccountId: string,
    role: CompanyRole,
  ): Promise<boolean>;
  roleOf(tx: Transaction, companyId: string, userAccountId: string): Promise<CompanyRole | null>;
  /** Keycloak subjects of the company's owners (notification recipients). */
  ownerSubjects(tx: Transaction, companyId: string): Promise<string[]>;
}

export interface Page {
  limit: number;
  offset: number;
}

export const USER_ACCOUNTS = Symbol('USER_ACCOUNTS');
export const COMPANIES = Symbol('COMPANIES');
export const MEMBERSHIPS = Symbol('MEMBERSHIPS');
