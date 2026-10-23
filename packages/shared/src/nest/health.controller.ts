import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import { AnonymousEndpoint } from './decorators';
import { READINESS_CHECK, type ReadinessCheck } from './tokens';

/** /health: the process is up. /ready: the database is reachable. Neither exposes configuration. */
@Controller()
export class HealthController {
  constructor(@Inject(READINESS_CHECK) private readonly ready: ReadinessCheck) {}

  @Get('health')
  @AnonymousEndpoint()
  @HttpCode(200)
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @AnonymousEndpoint()
  async readiness(): Promise<{ status: 'ready' }> {
    if (!(await this.ready())) {
      throw new ServiceUnavailableException();
    }
    return { status: 'ready' };
  }
}
