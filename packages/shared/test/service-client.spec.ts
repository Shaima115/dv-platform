import { Writable } from 'node:stream';
import { ClientCredentialsTokenProvider } from '../src/auth/token-provider';
import { DependencyUnavailableError, ServiceHttpClient } from '../src/http/service-client';
import { createLogger } from '../src/logging/logger';
import { createContext, runWithContext } from '../src/tracing/context';

const logger = createLogger({
  service: 't',
  environment: 'test',
  level: 'fatal',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const tokens = { getToken: async () => 'service-token', invalidate: jest.fn() };
const policy = { attemptTimeoutMs: 200, maxRetries: 2, backoffBaseMs: 5, overallDeadlineMs: 2_000 };

const respond = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ServiceHttpClient', () => {
  it('retries 502 twice with the same idempotency key, then gives up', async () => {
    const fetchImpl = jest.fn(async () => respond(502));
    const client = new ServiceHttpClient(
      'http://svc-verification.internal',
      tokens,
      policy,
      logger,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(
      client.postJson('/internal/v1/verifications', {}, 'key-123456'),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const keys = fetchImpl.mock.calls.map(
      (call) =>
        ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)[
          'idempotency-key'
        ],
    );
    expect(new Set(keys)).toEqual(new Set(['key-123456']));
  });

  it('recovers when a retry succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(201, { id: 'v1' }));
    const client = new ServiceHttpClient(
      'http://x.internal',
      tokens,
      policy,
      logger,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(client.postJson('/p', {}, 'key-123456')).resolves.toEqual({
      status: 201,
      body: { id: 'v1' },
      attempts: 2,
    });
  });

  it.each([400, 401, 403, 409])('does not retry a %s', async (status) => {
    const fetchImpl = jest.fn(async () => respond(status));
    const client = new ServiceHttpClient(
      'http://x.internal',
      tokens,
      policy,
      logger,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(client.postJson('/p', {}, 'key-123456')).resolves.toMatchObject({ status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging attempt and retries', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
          );
        }),
    );
    const client = new ServiceHttpClient(
      'http://x.internal',
      tokens,
      { ...policy, attemptTimeoutMs: 50 },
      logger,
      fetchImpl as unknown as typeof fetch,
    );
    const started = Date.now();
    await expect(client.postJson('/p', {}, 'key-123456')).rejects.toThrow('attempt timed out');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('respects the overall deadline', async () => {
    const fetchImpl = jest.fn(async () => respond(502));
    const client = new ServiceHttpClient(
      'http://x.internal',
      tokens,
      { ...policy, backoffBaseMs: 400, overallDeadlineMs: 300 },
      logger,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(client.postJson('/p', {}, 'key-123456')).rejects.toBeInstanceOf(
      DependencyUnavailableError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('propagates the request id and trace, and sends the service token', async () => {
    const fetchImpl = jest.fn(async () => respond(201, { id: 'v1' }));
    const client = new ServiceHttpClient(
      'http://x.internal',
      tokens,
      policy,
      logger,
      fetchImpl as unknown as typeof fetch,
    );
    const context = createContext({
      requestId: 'req-abcdef12',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    await runWithContext(context, () => client.postJson('/p', {}, 'key-123456'));
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers['x-request-id']).toBe('req-abcdef12');
    expect(headers.traceparent).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
    expect(headers.authorization).toBe('Bearer service-token');
  });
});

describe('ClientCredentialsTokenProvider', () => {
  const tokenResponse = (n: number) =>
    new Response(JSON.stringify({ access_token: `t${n}`, expires_in: 300 }), { status: 200 });

  it('caches the token and refreshes after 70% of its lifetime', async () => {
    let now = 0;
    let n = 0;
    const fetchImpl = jest.fn(async () => tokenResponse(++n));
    const provider = new ClientCredentialsTokenProvider({
      tokenUrl: 'http://kc/token',
      clientId: 'svc-core',
      clientSecret: 'secret-123',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    expect(await provider.getToken()).toBe('t1');
    now = 200_000;
    expect(await provider.getToken()).toBe('t1');
    now = 211_000;
    expect(await provider.getToken()).toBe('t2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent refreshes into one request', async () => {
    const fetchImpl = jest.fn(async () => tokenResponse(1));
    const provider = new ClientCredentialsTokenProvider({
      tokenUrl: 'http://kc/token',
      clientId: 'svc-core',
      clientSecret: 'secret-123',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await Promise.all(Array.from({ length: 10 }, () => provider.getToken()));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends the client credentials grant and surfaces failures without leaking the secret', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 401 }));
    const provider = new ClientCredentialsTokenProvider({
      tokenUrl: 'http://kc/token',
      clientId: 'svc-core',
      clientSecret: 'secret-123',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await provider.getToken().catch((e: Error) => e);
    expect(String(error)).not.toContain('secret-123');
    const body = String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(body).toContain('grant_type=client_credentials');
  });
});
