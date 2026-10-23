import type { TransactionRunner, UserPrincipal } from '@dv/shared';
import { CoreAction } from '../../domain/authorization/policy';
import {
  CompanyNotFoundError,
  MemberAlreadyExistsError,
  UserAccountNotFoundError,
} from '../../domain/company/company-errors';
import type { CompanyRole } from '../../domain/company/company-role';
import { ensureAllowed, userActor } from '../actor';
import type {
  CompanyRepository,
  MembershipRepository,
  UserAccountRepository,
} from '../ports/repositories';

/** Owners add representatives or employees. Company roles live only in company_member. */
export class AddMemberUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly accounts: UserAccountRepository,
    private readonly companies: CompanyRepository,
    private readonly memberships: MembershipRepository,
  ) {}

  execute(
    principal: UserPrincipal,
    companyId: string,
    input: { userAccountId: string; role: Exclude<CompanyRole, 'owner'> },
  ): Promise<{ companyId: string; userAccountId: string; role: CompanyRole }> {
    return this.transactions.run(async (tx) => {
      const account = await this.accounts.ensure(tx, principal.subject);
      const company = await this.companies.findForUpdate(tx, companyId);
      if (!company) throw new CompanyNotFoundError();
      const role = await this.memberships.roleOf(tx, companyId, account.id);
      if (role === null) throw new CompanyNotFoundError();
      ensureAllowed(CoreAction.ADD_MEMBER, userActor(principal, account), role);

      const target = await this.accounts.findById(tx, input.userAccountId);
      if (!target) throw new UserAccountNotFoundError();
      if (!(await this.memberships.add(tx, companyId, target.id, input.role))) {
        throw new MemberAlreadyExistsError();
      }
      return { companyId, userAccountId: target.id, role: input.role };
    });
  }
}
