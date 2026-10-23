import type { TransactionRunner, UserPrincipal } from '@dv/shared';
import { CoreAction } from '../../domain/authorization/policy';
import { ForbiddenActionError } from '../../domain/authorization/authorization-errors';
import { CompanyNotFoundError } from '../../domain/company/company-errors';
import { ensureAllowed, userActor } from '../actor';
import { toCompanyView, type CompanyView } from '../company-view';
import type {
  CompanyRepository,
  MembershipRepository,
  UserAccountRepository,
} from '../ports/repositories';

/** Members see their company; everyone else gets 404 so company ids cannot be probed. */
export class GetCompanyUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly accounts: UserAccountRepository,
    private readonly companies: CompanyRepository,
    private readonly memberships: MembershipRepository,
  ) {}

  execute(principal: UserPrincipal, companyId: string): Promise<CompanyView> {
    return this.transactions.run(async (tx) => {
      const account = await this.accounts.ensure(tx, principal.subject);
      const company = await this.companies.findById(tx, companyId);
      if (!company) throw new CompanyNotFoundError();
      const role = await this.memberships.roleOf(tx, companyId, account.id);
      try {
        ensureAllowed(CoreAction.VIEW_COMPANY, userActor(principal, account), role);
      } catch (error) {
        if (error instanceof ForbiddenActionError) throw new CompanyNotFoundError();
        throw error;
      }
      return toCompanyView(company, role!);
    });
  }
}
