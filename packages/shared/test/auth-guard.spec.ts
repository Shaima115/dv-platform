import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TokenVerifier } from '../src/auth/jwt-verifier';
import type { Principal } from '../src/auth/principal';
import { AuthGuard } from '../src/nest/auth.guard';
import { ENDPOINT_ACCESS, type EndpointAccess } from '../src/nest/decorators';

const userPrincipal: Principal = {
  kind: 'user',
  subject: 'u',
  clientId: 'web',
  realmRoles: new Set(),
};
const servicePrincipal = (clientId: string): Principal => ({
  kind: 'service',
  clientId,
  subject: 's',
});

function run(
  access: EndpointAccess | undefined,
  principal: Principal | null,
  header = 'Bearer a.b.c',
) {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(access);
  const verifier: TokenVerifier = { verify: jest.fn(async () => principal as Principal) };
  const request: Record<string, unknown> = { headers: header ? { authorization: header } : {} };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { promise: new AuthGuard(reflector, verifier).canActivate(context), request };
}

describe('AuthGuard', () => {
  it('denies routes without an access declaration (deny by default)', async () => {
    await expect(run(undefined, userPrincipal).promise).rejects.toMatchObject({
      statusCode: 403,
      code: 'AUTH_ENDPOINT_NOT_DECLARED',
    });
  });

  it('lets anonymous endpoints through without a token', async () => {
    await expect(run({ kind: 'anonymous' }, null, '').promise).resolves.toBe(true);
  });

  it('requires a token: 401 when missing', async () => {
    await expect(run({ kind: 'user' }, userPrincipal, '').promise).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_MISSING_TOKEN',
    });
  });

  it('accepts a user token on a user endpoint and attaches the principal', async () => {
    const { promise, request } = run({ kind: 'user' }, userPrincipal);
    await expect(promise).resolves.toBe(true);
    expect(request.principal).toBe(userPrincipal);
  });

  it('refuses a service token on a user endpoint (403)', async () => {
    await expect(run({ kind: 'user' }, servicePrincipal('svc-core')).promise).rejects.toMatchObject(
      { statusCode: 403, code: 'AUTH_WRONG_TOKEN_KIND' },
    );
  });

  it('refuses a user token on an internal endpoint (403)', async () => {
    await expect(
      run({ kind: 'internal', allowedCallers: ['svc-core'] }, userPrincipal).promise,
    ).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_WRONG_TOKEN_KIND' });
  });

  it('accepts only allow-listed services on internal endpoints', async () => {
    await expect(
      run({ kind: 'internal', allowedCallers: ['svc-core'] }, servicePrincipal('svc-core')).promise,
    ).resolves.toBe(true);
    await expect(
      run({ kind: 'internal', allowedCallers: ['svc-core'] }, servicePrincipal('svc-notification'))
        .promise,
    ).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_CALLER_NOT_ALLOWED' });
  });

  it('uses the reflector key exported for decorators', () => {
    expect(ENDPOINT_ACCESS).toBe('dv:endpoint-access');
  });
});
