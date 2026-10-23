import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { extractBearerToken, type TokenVerifier } from '../auth/jwt-verifier';
import { AppError, ErrorCodes, forbidden, unauthorized } from '../errors/app-error';
import { ENDPOINT_ACCESS, type AuthenticatedRequest, type EndpointAccess } from './decorators';
import { TOKEN_VERIFIER } from './tokens';

/**
 * Global guard, deny by default: a route without an access declaration is refused.
 * - user endpoints accept only user tokens (service tokens get 403),
 * - internal endpoints accept only service tokens from an explicit caller allowlist (user tokens get 403),
 * - missing, malformed, expired or foreign-realm tokens get 401.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<EndpointAccess | undefined>(ENDPOINT_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!access) {
      throw new AppError(
        403,
        ErrorCodes.AUTH_ENDPOINT_NOT_DECLARED,
        'Access to this endpoint is not declared.',
      );
    }
    if (access.kind === 'anonymous') return true;

    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw unauthorized(ErrorCodes.AUTH_MISSING_TOKEN, 'A bearer token is required.');
    }
    const principal = await this.verifier.verify(token);

    if (access.kind === 'user' && principal.kind !== 'user') {
      throw forbidden(
        ErrorCodes.AUTH_WRONG_TOKEN_KIND,
        'Public endpoints accept user tokens only.',
      );
    }
    if (access.kind === 'internal') {
      if (principal.kind !== 'service') {
        throw forbidden(
          ErrorCodes.AUTH_WRONG_TOKEN_KIND,
          'Internal endpoints accept service tokens only.',
        );
      }
      if (!access.allowedCallers.includes(principal.clientId)) {
        throw forbidden(
          ErrorCodes.AUTH_CALLER_NOT_ALLOWED,
          'This service may not call this endpoint.',
        );
      }
    }
    request.principal = principal;
    return true;
  }
}
