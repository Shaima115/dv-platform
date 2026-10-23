/** A human user authenticated through the public `web` client. */
export interface UserPrincipal {
  readonly kind: 'user';
  /** Keycloak subject (stable user id). */
  readonly subject: string;
  /** Realm roles from the verified token (platform roles such as `reviewer`, `admin`). */
  readonly realmRoles: ReadonlySet<string>;
  /** Client that obtained the token (`azp`). */
  readonly clientId: string;
}

/** A backend service authenticated with the client credentials grant. */
export interface ServicePrincipal {
  readonly kind: 'service';
  /** Calling service client id (`azp`), e.g. `svc-core`. */
  readonly clientId: string;
  readonly subject: string;
}

export type Principal = UserPrincipal | ServicePrincipal;

export const isUser = (principal: Principal): principal is UserPrincipal =>
  principal.kind === 'user';
export const isService = (principal: Principal): principal is ServicePrincipal =>
  principal.kind === 'service';

/** Platform roles defined in the Keycloak realm. Company roles never come from tokens. */
export const PlatformRole = {
  REVIEWER: 'reviewer',
  ADMIN: 'admin',
} as const;

export type PlatformRole = (typeof PlatformRole)[keyof typeof PlatformRole];
