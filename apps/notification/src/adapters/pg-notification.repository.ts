import type { Transaction } from '@dv/shared';
import type { Notification } from '../domain/notification';
import type { NotificationRepository } from '../application/ports';

export class PgNotificationRepository implements NotificationRepository {
  async insertOnce(tx: Transaction, n: Notification): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO notification.notification (id, recipient_subject, company_id, event_id, message_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ON CONSTRAINT notification_event_recipient_uq DO NOTHING`,
      [n.id, n.recipientSubject, n.companyId, n.eventId, n.messageCode, n.createdAt],
    );
    return result.rowCount === 1;
  }

  async listForRecipient(
    tx: Transaction,
    subject: string,
    page: { limit: number; offset: number },
  ) {
    const { rows } = await tx.query<{
      id: string;
      recipient_subject: string;
      company_id: string;
      event_id: string;
      message_code: 'COMPANY_APPROVED';
      created_at: Date;
      total: string;
    }>(
      `SELECT id, recipient_subject, company_id, event_id, message_code, created_at, count(*) OVER () AS total
         FROM notification.notification
        WHERE recipient_subject = $1
        ORDER BY created_at DESC, id
        LIMIT $2 OFFSET $3`,
      [subject, page.limit, page.offset],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        recipientSubject: r.recipient_subject,
        companyId: r.company_id,
        eventId: r.event_id,
        messageCode: r.message_code,
        createdAt: r.created_at,
      })),
      total: Number(rows[0]?.total ?? 0),
    };
  }
}
