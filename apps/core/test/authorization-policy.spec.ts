import {
  authorize,
  CoreAction,
  type Actor,
  type CoreAction as Action,
} from '../src/domain/authorization/policy';
import type { CompanyRole } from '../src/domain/company/company-role';

const user = (roles: string[] = []): Actor => ({
  kind: 'user',
  userAccountId: 'u1',
  platformRoles: new Set(roles),
});
const service: Actor = { kind: 'service', platformRoles: new Set() };

describe('core authorization policy (deny by default)', () => {
  const matrix: Array<[Action, CompanyRole | null, boolean]> = [
    [CoreAction.REQUEST_VERIFICATION, 'owner', true],
    [CoreAction.REQUEST_VERIFICATION, 'representative', true],
    [CoreAction.REQUEST_VERIFICATION, 'employee', false],
    [CoreAction.REQUEST_VERIFICATION, null, false],
    [CoreAction.VIEW_COMPANY, 'owner', true],
    [CoreAction.VIEW_COMPANY, 'representative', true],
    [CoreAction.VIEW_COMPANY, 'employee', true],
    [CoreAction.VIEW_COMPANY, null, false],
    [CoreAction.ADD_MEMBER, 'owner', true],
    [CoreAction.ADD_MEMBER, 'representative', false],
    [CoreAction.ADD_MEMBER, 'employee', false],
    [CoreAction.ADD_MEMBER, null, false],
    [CoreAction.CREATE_COMPANY, null, true],
    [CoreAction.LIST_OWN_COMPANIES, null, true],
  ];

  it.each(matrix)('%s with company role %s → %s', (action, role, expected) => {
    expect(authorize(action, user(), { companyRole: role }).allowed).toBe(expected);
  });

  it('platform roles never substitute for company roles', () => {
    for (const roles of [['reviewer'], ['admin'], ['reviewer', 'admin']]) {
      expect(
        authorize(CoreAction.REQUEST_VERIFICATION, user(roles), { companyRole: null }),
      ).toEqual({ allowed: false, reason: 'not_a_member' });
    }
  });

  it('explains why an employee is refused', () => {
    expect(authorize(CoreAction.REQUEST_VERIFICATION, user(), { companyRole: 'employee' })).toEqual(
      { allowed: false, reason: 'insufficient_role' },
    );
  });

  it('service principals cannot perform any user action', () => {
    for (const action of Object.values(CoreAction)) {
      expect(authorize(action, service, { companyRole: 'owner' })).toEqual({
        allowed: false,
        reason: 'not_a_user',
      });
    }
  });

  it('unknown actions are denied', () => {
    expect(authorize('company:delete' as Action, user(), { companyRole: 'owner' })).toEqual({
      allowed: false,
      reason: 'unknown_action',
    });
  });
});
