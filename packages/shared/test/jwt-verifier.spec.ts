import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import { type AppError } from '../src/errors/app-error';
import { JwtVerifier, extractBearerToken } from '../src/auth/jwt-verifier';

const ISSUER = 'http://kc.test/realms/jo';
let privateKey: KeyLike;
let foreignKey: KeyLike;
let verifier: JwtVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  foreignKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  verifier = new JwtVerifier({
    issuer: ISSUER,
    jwksUri: 'http://unused.test/certs',
    audience: 'svc-core',
    userClientIds: ['web'],
    serviceClientIds: ['svc-verification', 'svc-core'],
    keyResolver: createLocalJWKSet({ keys: [jwk] }),
  });
});

async function token(
  claims: JWTPayload,
  options: { key?: KeyLike; exp?: string | number; iss?: string; aud?: string | string[] } = {},
) {
  const jwt = new SignJWT({
    typ: 'Bearer',
    azp: 'web',
    token_kind: 'user',
    realm_access: { roles: ['reviewer'] },
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? 'svc-core')
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(options.exp ?? '5m');
  return jwt.sign(options.key ?? privateKey);
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected rejection');
}

describe('JwtVerifier', () => {
  it('accepts a user token and reads realm roles', async () => {
    const principal = await verifier.verify(await token({}));
    expect(principal).toMatchObject({ kind: 'user', subject: 'user-1', clientId: 'web' });
    expect(principal.kind === 'user' && principal.realmRoles.has('reviewer')).toBe(true);
  });

  it('accepts a service token from an allowed client', async () => {
    const principal = await verifier.verify(
      await token({ azp: 'svc-verification', token_kind: 'service' }),
    );
    expect(principal).toEqual({ kind: 'service', clientId: 'svc-verification', subject: 'user-1' });
  });

  it.each([
    ['wrong issuer (another realm)', { iss: 'http://kc.test/realms/other' }],
    ['wrong audience', { aud: 'svc-notification' }],
    ['foreign signing key', { key: undefined as unknown as KeyLike }],
  ])('rejects %s with 401 AUTH_INVALID_TOKEN', async (_label, options) => {
    const opts = 'key' in options ? { key: foreignKey } : options;
    const error = await rejection(verifier.verify(await token({}, opts)));
    expect(error).toMatchObject({ statusCode: 401, code: 'AUTH_INVALID_TOKEN' });
  });

  it('rejects an expired token with AUTH_TOKEN_EXPIRED', async () => {
    const error = await rejection(
      verifier.verify(await token({}, { exp: Math.floor(Date.now() / 1000) - 10 })),
    );
    expect(error).toMatchObject({ statusCode: 401, code: 'AUTH_TOKEN_EXPIRED' });
  });

  it('rejects a token that is not yet valid (nbf)', async () => {
    const error = await rejection(
      verifier.verify(await token({ nbf: Math.floor(Date.now() / 1000) + 600 })),
    );
    expect(error.statusCode).toBe(401);
  });

  it('rejects ID and refresh tokens (typ)', async () => {
    const error = await rejection(verifier.verify(await token({ typ: 'ID' })));
    expect(error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it.each([
    ['user kind from a service client', { azp: 'svc-core', token_kind: 'user' }],
    ['service kind from the web client', { azp: 'web', token_kind: 'service' }],
    ['unknown client', { azp: 'evil', token_kind: 'service' }],
    ['missing token_kind', { token_kind: undefined }],
  ])('refuses an ambiguous principal: %s', async (_label, claims) => {
    const error = await rejection(verifier.verify(await token(claims)));
    expect(error).toMatchObject({ statusCode: 401, code: 'AUTH_INVALID_TOKEN' });
  });

  it('rejects an alg=none token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: 'svc-core',
        sub: 'x',
        azp: 'web',
        token_kind: 'user',
        exp: 9999999999,
        iat: 1,
      }),
    ).toString('base64url');
    const error = await rejection(verifier.verify(`${header}.${body}.`));
    expect(error.statusCode).toBe(401);
  });
});

describe('extractBearerToken', () => {
  it('extracts a JWT from a Bearer header', () => {
    expect(extractBearerToken('Bearer aaa.bbb.ccc')).toBe('aaa.bbb.ccc');
  });
  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer not-a-jwt'])(
    'returns undefined for %p',
    (value) => {
      expect(extractBearerToken(value)).toBeUndefined();
    },
  );
});
