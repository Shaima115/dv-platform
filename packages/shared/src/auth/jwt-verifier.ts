import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { AppError, ErrorCodes, unauthorized } from '../errors/app-error';
import type { Principal } from './principal';

export interface JwtVerifierOptions {
  issuer: string;
  jwksUri: string;
  /** This service's audience. Tokens not addressed to it are rejected. */
  audience: string;
  /** Clients allowed to mint user tokens (normally only `web`). */
  userClientIds: readonly string[];
  /** Clients allowed to act as service principals. */
  serviceClientIds: readonly string[];
  clockToleranceSeconds?: number;
  /** How long fetched signing keys are cached before a refresh. */
  jwksCacheMaxAgeMs?: number;
  /** Injected key resolver (tests). Defaults to the remote JWKS with caching. */
  keyResolver?: JWTVerifyGetKey;
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

/** Claim set by a hardcoded mapper on every Keycloak client: 'user' for `web`, 'service' for svc-*. */
export const TOKEN_KIND_CLAIM = 'token_kind';

interface KeycloakClaims extends JWTPayload {
  azp?: string;
  typ?: string;
  token_kind?: string;
  realm_access?: { roles?: unknown };
}

/**
 * Verifies Keycloak access tokens locally: signature against the cached JWKS (refetched on an unknown
 * `kid`, which handles key rotation), issuer, audience, expiry and not-before. No introspection call.
 * Then classifies the token as a user or a service principal; anything ambiguous is rejected.
 */
export class JwtVerifier implements TokenVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly userClients: ReadonlySet<string>;
  private readonly serviceClients: ReadonlySet<string>;

  constructor(private readonly options: JwtVerifierOptions) {
    this.keys =
      options.keyResolver ??
      createRemoteJWKSet(new URL(options.jwksUri), {
        cacheMaxAge: options.jwksCacheMaxAgeMs ?? 10 * 60_000,
        cooldownDuration: 30_000,
        timeoutDuration: 3_000,
      });
    this.userClients = new Set(options.userClientIds);
    this.serviceClients = new Set(options.serviceClientIds);
  }

  async verify(token: string): Promise<Principal> {
    let claims: KeycloakClaims;
    try {
      const result = await jwtVerify<KeycloakClaims>(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ['RS256', 'PS256', 'ES256'],
        clockTolerance: this.options.clockToleranceSeconds ?? 0,
        requiredClaims: ['exp', 'iat', 'sub', 'azp'],
      });
      claims = result.payload;
    } catch (error) {
      throw this.mapVerificationError(error);
    }

    if (claims.typ !== undefined && claims.typ !== 'Bearer') {
      throw unauthorized(ErrorCodes.AUTH_INVALID_TOKEN, 'Only access tokens are accepted.');
    }

    const clientId = claims.azp as string;
    const subject = claims.sub as string;

    if (claims.token_kind === 'service' && this.serviceClients.has(clientId)) {
      return { kind: 'service', clientId, subject };
    }
    if (claims.token_kind === 'user' && this.userClients.has(clientId)) {
      return { kind: 'user', subject, clientId, realmRoles: new Set(readRoles(claims)) };
    }
    throw unauthorized(
      ErrorCodes.AUTH_INVALID_TOKEN,
      'Token was not issued to a recognised client.',
    );
  }

  private mapVerificationError(error: unknown): AppError {
    if (error instanceof joseErrors.JWTExpired) {
      return unauthorized(ErrorCodes.AUTH_TOKEN_EXPIRED, 'The access token has expired.');
    }
    if (error instanceof joseErrors.JWKSTimeout) {
      return new AppError(
        503,
        'AUTH_KEYS_UNAVAILABLE',
        'Signing keys are temporarily unavailable.',
      );
    }
    return unauthorized(ErrorCodes.AUTH_INVALID_TOKEN, 'The access token is invalid.');
  }
}

function readRoles(claims: KeycloakClaims): string[] {
  const roles = claims.realm_access?.roles;
  return Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === 'string')
    : [];
}

/** Extracts a bearer token from an Authorization header value. */
export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+([A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_.+/=]*)$/.exec(
    header.trim(),
  );
  return match?.[1];
}
