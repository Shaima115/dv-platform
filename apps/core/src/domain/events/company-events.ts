/** Domain events raised by the company aggregate. The application layer turns them into integration events. */
export interface CompanyCreatedEvent {
  readonly type: 'CompanyCreated';
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly countryCode: string;
}

export interface CompanyApprovedEvent {
  readonly type: 'CompanyApproved';
  readonly companyId: string;
  readonly verificationId: string;
}

export type CompanyDomainEvent = CompanyCreatedEvent | CompanyApprovedEvent;
