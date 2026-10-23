import type {
  CompanyApprovedV1,
  EventEnvelope,
  EventHandler,
  EventHandlingResult,
  Logger,
  Transaction,
  TransactionRunner,
  UserPrincipal,
} from '@dv/shared';
import { EventTypes } from '@dv/shared';
import { notificationForApproval } from '../domain/notification';
import type { FaultInjector, NotificationRepository } from './ports';

/**
 * Consumes dv.jo.core.company_approved.v1 inside the inbox transaction. "Sending" is a structured log
 * line with ids only. If anything throws, the inbox row rolls back and core's relay retries.
 */
export class HandleCompanyApproved implements EventHandler<CompanyApprovedV1> {
  readonly eventTypes = [EventTypes.COMPANY_APPROVED];

  constructor(
    private readonly repository: NotificationRepository,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
    private readonly logger: Logger,
    private readonly faults?: FaultInjector,
  ) {}

  async handle(
    tx: Transaction,
    event: EventEnvelope<CompanyApprovedV1>,
  ): Promise<EventHandlingResult> {
    if (this.faults?.shouldFail(event.data.company_id)) {
      throw new Error('fault injected for this company (development only)');
    }
    const notification = notificationForApproval({
      id: this.ids.next(),
      eventId: event.event_id,
      companyId: event.data.company_id,
      ownerSubject: event.data.owner_subject,
      now: this.clock.now(),
    });
    const created = await this.repository.insertOnce(tx, notification);
    if (!created) {
      return {
        outcome: 'ignored',
        reason: 'notification already exists for this event and recipient',
      };
    }
    this.logger.info(
      {
        operation: 'notify',
        notification_id: notification.id,
        company_id: notification.companyId,
        message_code: notification.messageCode,
        event_id: event.event_id,
      },
      'notification sent (logged instead of delivered)',
    );
    return { outcome: 'applied' };
  }
}

export class ListMyNotificationsUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly repository: NotificationRepository,
  ) {}

  /** A user only ever sees notifications addressed to their own subject. */
  execute(user: UserPrincipal, page: { limit: number; offset: number }) {
    return this.transactions.run(async (tx) => {
      const result = await this.repository.listForRecipient(tx, user.subject, page);
      return {
        items: result.items.map((n) => ({
          id: n.id,
          company_id: n.companyId,
          message_code: n.messageCode,
          event_id: n.eventId,
          created_at: n.createdAt.toISOString(),
        })),
        total: result.total,
        limit: page.limit,
        offset: page.offset,
      };
    });
  }
}
