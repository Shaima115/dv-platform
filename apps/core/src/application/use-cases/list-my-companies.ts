import type { TransactionRunner, UserPrincipal } from '@dv/shared';
import { CoreAction } from '../../domain/authorization/policy';
import { ensureAllowed, userActor } from '../actor';
import type {
  CompanyRepository,
  CompanySummary,
  Page,
  UserAccountRepository,
} from '../ports/repositories';

export interface CompanyList {
  items: Array<Omit<CompanySummary, 'createdAt'> & { createdAt: string }>;
  total: number;
  limit: number;
  offset: number;
}

export class ListMyCompaniesUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly accounts: UserAccountRepository,
    private readonly companies: CompanyRepository,
  ) {}

  execute(principal: UserPrincipal, page: Page): Promise<CompanyList> {
    return this.transactions.run(async (tx) => {
      const account = await this.accounts.ensure(tx, principal.subject);
      ensureAllowed(CoreAction.LIST_OWN_COMPANIES, userActor(principal, account), null);
      const result = await this.companies.listForMember(tx, account.id, page);
      return {
        items: result.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
        total: result.total,
        limit: page.limit,
        offset: page.offset,
      };
    });
  }
}
