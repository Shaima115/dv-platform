import type { TransactionRunner, UserPrincipal } from '@dv/shared';
import type { UserAccountRepository } from '../ports/repositories';

export interface MeView {
  userAccountId: string;
  subject: string;
  platformRoles: string[];
}

/** Returns (and on first sight creates) the caller's account. */
export class GetMeUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly accounts: UserAccountRepository,
  ) {}

  execute(principal: UserPrincipal): Promise<MeView> {
    return this.transactions.run(async (tx) => {
      const account = await this.accounts.ensure(tx, principal.subject);
      return {
        userAccountId: account.id,
        subject: principal.subject,
        platformRoles: [...principal.realmRoles].filter(
          (role) => role === 'reviewer' || role === 'admin',
        ),
      };
    });
  }
}
