import type { Logger } from 'pino';
import { describeError } from '../logging/logger';

export interface ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Refresh once this fraction of the token lifetime has elapsed. */
  refreshAtLifetimeFraction?: number;
  requestTimeoutMs?: number;
  logger: Logger;
  /** Injected fetch (tests). */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ServiceTokenSource {
  getToken(): Promise<string>;
  /** Drops the cached token, e.g. after a 401 from a downstream service. */
  invalidate(): void;
}

interface CachedToken {
  value: string;
  refreshAt: number;
  expiresAt: number;
}

export class TokenAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenAcquisitionError';
  }
}

/**
 * Obtains this service's own access token with the OAuth 2.0 client credentials grant.
 * Caches it, refreshes before expiry, and collapses concurrent refreshes into one request.
 * The token and secret are never logged.
 */
export class ClientCredentialsTokenProvider implements ServiceTokenSource {
  private cached: CachedToken | undefined;
  private inFlight: Promise<string> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ClientCredentialsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    const now = this.now();
    if (this.cached && now < this.cached.refreshAt) {
      return this.cached.value;
    }
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => {
        this.inFlight = undefined;
      });
    }
    try {
      return await this.inFlight;
    } catch (error) {
      // A still-valid cached token is better than failing the call during a refresh hiccup.
      if (this.cached && this.now() < this.cached.expiresAt - 5_000) {
        this.options.logger.warn(
          { operation: 'token_refresh', ...describeError(error) },
          'token refresh failed; using cached token',
        );
        return this.cached.value;
      }
      throw error;
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 3_000),
      });
    } catch (error) {
      throw new TokenAcquisitionError(
        `token endpoint unreachable: ${describeError(error).error_message}`,
      );
    }
    if (!response.ok) {
      throw new TokenAcquisitionError(`token endpoint answered ${response.status}`);
    }
    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== 'string' || typeof payload.expires_in !== 'number') {
      throw new TokenAcquisitionError('token endpoint returned an unexpected payload');
    }
    const issuedAt = this.now();
    const lifetimeMs = payload.expires_in * 1000;
    const fraction = this.options.refreshAtLifetimeFraction ?? 0.7;
    this.cached = {
      value: payload.access_token,
      refreshAt: issuedAt + lifetimeMs * fraction,
      expiresAt: issuedAt + lifetimeMs,
    };
    this.options.logger.debug(
      {
        operation: 'token_refresh',
        client_id: this.options.clientId,
        expires_in_s: payload.expires_in,
      },
      'service token acquired',
    );
    return payload.access_token;
  }
}
