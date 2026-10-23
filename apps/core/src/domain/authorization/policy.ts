import type { CompanyRole } from '../company/company-role';

/**
 * The single authorization policy for core. Deny by default: an action is allowed only if a rule
 * below explicitly allows it. Platform roles come from the verified token; company roles come from
 * company_member and are passed in by the application layer — never read from a token or a request.
 */
export const CoreAction = {
  CREATE_COMPANY: 'company:create',
  VIEW_COMPANY: 'company:view',
  LIST_OWN_COMPANIES: 'company:list-own',
  REQUEST_VERIFICATION: 'company:request-verification',
  ADD_MEMBER: 'company:add-member',
} as const;

export type CoreAction = (typeof CoreAction)[keyof typeof CoreAction];

export interface Actor {
  readonly kind: 'user' | 'service';
  readonly userAccountId?: string;
  readonly platformRoles: ReadonlySet<string>;
}

export interface AuthorizationContext {
  /** The actor's role in the target company, or null when not a member / no company involved. */
  readonly companyRole: CompanyRole | null;
}

export type AuthorizationDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'not_a_user' | 'not_a_member' | 'insufficient_role' | 'unknown_action';
    };

type Rule = (actor: Actor, context: AuthorizationContext) => AuthorizationDecision;

const ALLOW: AuthorizationDecision = { allowed: true };
const deny = (
  reason: Exclude<AuthorizationDecision, { allowed: true }>['reason'],
): AuthorizationDecision => ({
  allowed: false,
  reason,
});

const requireUser =
  (rule: Rule): Rule =>
  (actor, context) =>
    actor.kind === 'user' && actor.userAccountId ? rule(actor, context) : deny('not_a_user');

const memberWithRole =
  (...roles: CompanyRole[]): Rule =>
  (_actor, context) => {
    if (context.companyRole === null) return deny('not_a_member');
    return roles.includes(context.companyRole) ? ALLOW : deny('insufficient_role');
  };

const RULES: Readonly<Record<CoreAction, Rule>> = {
  [CoreAction.CREATE_COMPANY]: requireUser(() => ALLOW),
  [CoreAction.LIST_OWN_COMPANIES]: requireUser(() => ALLOW),
  [CoreAction.VIEW_COMPANY]: requireUser(memberWithRole('owner', 'representative', 'employee')),
  [CoreAction.REQUEST_VERIFICATION]: requireUser(memberWithRole('owner', 'representative')),
  [CoreAction.ADD_MEMBER]: requireUser(memberWithRole('owner')),
};

export function authorize(
  action: CoreAction,
  actor: Actor,
  context: AuthorizationContext,
): AuthorizationDecision {
  const rule = Object.prototype.hasOwnProperty.call(RULES, action) ? RULES[action] : undefined;
  return rule ? rule(actor, context) : deny('unknown_action');
}
