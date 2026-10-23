import type { Transaction } from '@dv/shared';
import type { Notification } from '../domain/notification';

export interface NotificationRepository {
  /** Inserts once per (event, recipient); returns false when it already exists. */
  insertOnce(tx: Transaction, notification: Notification): Promise<boolean>;
  listForRecipient(
    tx: Transaction,
    subject: string,
    page: { limit: number; offset: number },
  ): Promise<{ items: Notification[]; total: number }>;
}

/** Development-only hook used by demo scenario 10; always absent in production. */
export interface FaultInjector {
  shouldFail(companyId: string): boolean;
}
