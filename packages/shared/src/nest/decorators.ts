import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Principal, ServicePrincipal, UserPrincipal } from '../auth/principal';

export const ENDPOINT_ACCESS = 'dv:endpoint-access';

export type EndpointAccess =
  | { kind: 'anonymous' }
  | { kind: 'user' }
  | { kind: 'internal'; allowedCallers: readonly string[] };

/** Public API endpoint: user tokens only. */
export const UserEndpoint = () =>
  SetMetadata(ENDPOINT_ACCESS, { kind: 'user' } satisfies EndpointAccess);

/** Internal endpoint: service tokens only, from the listed client ids. */
export const InternalEndpoint = (...allowedCallers: string[]) =>
  SetMetadata(ENDPOINT_ACCESS, { kind: 'internal', allowedCallers } satisfies EndpointAccess);

/** No token required (health and readiness only). */
export const AnonymousEndpoint = () =>
  SetMetadata(ENDPOINT_ACCESS, { kind: 'anonymous' } satisfies EndpointAccess);

export interface AuthenticatedRequest {
  principal?: Principal;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserPrincipal => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal || principal.kind !== 'user') {
      throw new Error('CurrentUser used on an endpoint that is not a user endpoint');
    }
    return principal;
  },
);

export const CurrentService = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ServicePrincipal => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal || principal.kind !== 'service') {
      throw new Error('CurrentService used on an endpoint that is not an internal endpoint');
    }
    return principal;
  },
);
