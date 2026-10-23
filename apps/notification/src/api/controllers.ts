import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  InternalEndpoint,
  parseIncomingEvent,
  UserEndpoint,
  ZodValidationPipe,
  type CompanyApprovedV1,
  type EventHandler,
  type TransactionalInbox,
  type UserPrincipal,
} from '@dv/shared';
import { z } from 'zod';
import type { ListMyNotificationsUseCase } from '../application/use-cases';

export const LIST = Symbol('ListMyNotifications');
export const HANDLER = Symbol('HandleCompanyApproved');
export const INBOX = Symbol('TransactionalInbox');

const pageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

@Controller('api/v1/notifications')
@UserEndpoint()
export class NotificationsController {
  constructor(@Inject(LIST) private readonly list: ListMyNotificationsUseCase) {}

  @Get()
  mine(
    @CurrentUser() user: UserPrincipal,
    @Query(new ZodValidationPipe(pageSchema)) page: z.infer<typeof pageSchema>,
  ) {
    return this.list.execute(user, page);
  }
}

/** Inbox for company_approved events; only svc-core may post here. */
@Controller('internal/v1/events')
export class InternalEventsController {
  constructor(
    @Inject(INBOX) private readonly inbox: TransactionalInbox,
    @Inject(HANDLER) private readonly handler: EventHandler<CompanyApprovedV1>,
  ) {}

  @Post()
  @HttpCode(200)
  @InternalEndpoint('svc-core')
  async receive(@Body() body: unknown) {
    const event = parseIncomingEvent<CompanyApprovedV1>(body, this.handler.eventTypes);
    const result = await this.inbox.process(event, this.handler);
    return {
      event_id: event.event_id,
      status: result.status,
      ...(result.status === 'processed' ? { outcome: result.result.outcome } : {}),
    };
  }
}
