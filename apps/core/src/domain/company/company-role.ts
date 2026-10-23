/** Roles a user holds inside one company. Stored in company_member; never read from a token. */
export type CompanyRole = 'owner' | 'representative' | 'employee';

export const COMPANY_ROLES: readonly CompanyRole[] = ['owner', 'representative', 'employee'];
