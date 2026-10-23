import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import {
  InternalEndpoint,
  parseIncomingEvent,
  type EventHandler,
  type TransactionalInbox,
  type VerificationCompletedV1,
} from '@dv/shared';
import { INBOX, VERIFICATION_COMPLETED_HANDLER } from '../tokens';

/**
 * Event inbox. Service tokens only, and only from svc-verification. Answers 200 only after the inbox
 * row and the state change have committed; 200 again (no side effects) for a duplicate.
 */
@Controller('internal/v1/events')
export class InternalEventsController {
  constructor(
    @Inject(INBOX) private readonly inbox: TransactionalInbox,
    @Inject(VERIFICATION_COMPLETED_HANDLER)
    private readonly handler: EventHandler<VerificationCompletedV1>,
  ) {}

  @Post()
  @HttpCode(200)
  @InternalEndpoint('svc-verification')
  async receive(@Body() body: unknown) {
    const event = parseIncomingEvent<VerificationCompletedV1>(body, this.handler.eventTypes);
    const result = await this.inbox.process(event, this.handler);
    return {
      event_id: event.event_id,
      status: result.status,
      ...(result.status === 'processed' ? { outcome: result.result.outcome } : {}),
    };
  }
}
