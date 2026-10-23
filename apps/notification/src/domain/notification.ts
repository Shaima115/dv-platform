/** A notification for one recipient, created from one event. Message codes, never free text with PII. */
export interface Notification {
  id: string;
  recipientSubject: string;
  companyId: string;
  eventId: string;
  messageCode: 'COMPANY_APPROVED';
  createdAt: Date;
}

export function notificationForApproval(input: {
  id: string;
  eventId: string;
  companyId: string;
  ownerSubject: string;
  now: Date;
}): Notification {
  return {
    id: input.id,
    recipientSubject: input.ownerSubject,
    companyId: input.companyId,
    eventId: input.eventId,
    messageCode: 'COMPANY_APPROVED',
    createdAt: input.now,
  };
}
