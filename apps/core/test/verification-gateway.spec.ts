import { createLogger, DependencyUnavailableError, type ServiceHttpClient } from '@dv/shared';
import { Writable } from 'node:stream';
import { HttpVerificationGateway } from '../src/adapters/http/verification-gateway.adapter';
import {
  VerificationRefusedError,
  VerificationUnavailableError,
} from '../src/application/ports/verification-gateway';

const silent = createLogger({
  service: 'test',
  environment: 'test',
  level: 'fatal',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const settings = {
  errorThresholdPercentage: 50,
  volumeThreshold: 3,
  rollingCountTimeout: 10_000,
  resetTimeout: 60_000,
};
const submission = { companyId: 'c1', requestedBySubject: 's1' };

function clientReturning(respond: () => Promise<unknown>): {
  client: ServiceHttpClient;
  postJson: jest.Mock;
} {
  const postJson = jest.fn(respond);
  return { client: { postJson } as unknown as ServiceHttpClient, postJson };
}

describe('HttpVerificationGateway', () => {
  it('returns the verification id on 201', async () => {
    const { client } = clientReturning(async () => ({
      status: 201,
      body: { id: 'v1' },
      attempts: 1,
    }));
    await expect(
      new HttpVerificationGateway(client, settings, silent).submit(submission, 'k'),
    ).resolves.toEqual({ verificationId: 'v1' });
  });

  it('maps an unreachable dependency to VerificationUnavailableError', async () => {
    const { client } = clientReturning(async () => {
      throw new DependencyUnavailableError('down', 3, 502);
    });
    await expect(
      new HttpVerificationGateway(client, settings, silent).submit(submission, 'k'),
    ).rejects.toMatchObject({ circuitOpen: false });
  });

  it('opens the circuit after repeated failures and then fails fast without calling out', async () => {
    const mock = clientReturning(async () => {
      throw new DependencyUnavailableError('down', 3, 502);
    });
    const gateway = new HttpVerificationGateway(mock.client, settings, silent);
    for (let i = 0; i < 3; i += 1) {
      await expect(gateway.submit(submission, 'k')).rejects.toBeInstanceOf(
        VerificationUnavailableError,
      );
    }
    expect(gateway.circuitState).toBe('open');
    const callsBefore = mock.postJson.mock.calls.length;
    await expect(gateway.submit(submission, 'k')).rejects.toMatchObject({ circuitOpen: true });
    expect(mock.postJson.mock.calls.length).toBe(callsBefore);
  });

  it('does not count definitive refusals (409) as failures', async () => {
    const { client } = clientReturning(async () => ({
      status: 409,
      body: { code: 'VERIFICATION_ALREADY_PENDING' },
      attempts: 1,
    }));
    const gateway = new HttpVerificationGateway(client, settings, silent);
    for (let i = 0; i < 5; i += 1) {
      await expect(gateway.submit(submission, 'k')).rejects.toBeInstanceOf(
        VerificationRefusedError,
      );
    }
    expect(gateway.circuitState).toBe('closed');
  });
});
