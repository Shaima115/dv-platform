import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import {
  badRequest,
  CurrentService,
  CurrentUser,
  InternalEndpoint,
  isValidIdempotencyKey,
  UserEndpoint,
  ZodValidationPipe,
  type ServicePrincipal,
  type UserPrincipal,
} from '@dv/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type {
  CreateVerificationRequestUseCase,
  DecideVerificationUseCase,
  GetVerificationRequestUseCase,
} from '../application/use-cases';

export const CREATE = Symbol('CreateVerificationRequest');
export const GET = Symbol('GetVerificationRequest');
export const DECIDE = Symbol('DecideVerification');

const createSchema = z
  .object({ company_id: z.string().uuid(), requested_by_subject: z.string().min(1).max(64) })
  .strict();

const decisionSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reasonCode: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/, 'snake_case code, e.g. documents_valid'),
    comment: z.string().trim().max(500).optional(),
  })
  .strict();

const uuid = z.string().uuid();

/** Internal API: svc-core only. */
@Controller('internal/v1/verifications')
@InternalEndpoint('svc-core')
export class InternalVerificationsController {
  constructor(
    @Inject(CREATE) private readonly create: CreateVerificationRequestUseCase,
    @Inject(GET) private readonly get: GetVerificationRequestUseCase,
  ) {}

  @Post()
  async createRequest(
    @CurrentService() caller: ServicePrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!isValidIdempotencyKey(idempotencyKey)) {
      throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required.');
    }
    const result = await this.create.execute(caller, idempotencyKey, body);
    // A replay returns the original response: same status, same body.
    res.status(201);
    if (result.replayed) res.setHeader('idempotent-replayed', 'true');
    return result.view;
  }

  @Get(':id')
  getRequest(@Param('id', new ZodValidationPipe(uuid)) id: string) {
    return this.get.execute(id);
  }
}

/** Public admin API: user tokens; the use case requires the reviewer realm role. */
@Controller('api/v1/admin/verifications')
@UserEndpoint()
export class AdminVerificationsController {
  constructor(@Inject(DECIDE) private readonly decide: DecideVerificationUseCase) {}

  @Post(':id/decision')
  @HttpCode(200)
  decision(
    @CurrentUser() user: UserPrincipal,
    @Param('id', new ZodValidationPipe(uuid)) id: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
  ) {
    return this.decide.execute(user, id, body);
  }
}
