import type { UserPrincipal } from '@dv/shared';
import type { Actor } from '../domain/authorization/policy';
import { authorize, type CoreAction } from '../domain/authorization/policy';
import { ForbiddenActionError } from '../domain/authorization/authorization-errors';
import type { CompanyRole } from '../domain/company/company-role';
import type { UserAccount } from './ports/repositories';

export function userActor(principal: UserPrincipal, account: UserAccount): Actor {
  return { kind: 'user', userAccountId: account.id, platformRoles: principal.realmRoles };
}

/** Runs the central policy and throws when denied. Every use case calls this; controllers never decide. */
export function ensureAllowed(
  action: CoreAction,
  actor: Actor,
  companyRole: CompanyRole | null,
): void {
  const decision = authorize(action, actor, { companyRole });
  if (!decision.allowed) {
    throw new ForbiddenActionError(action, decision.reason);
  }
}
