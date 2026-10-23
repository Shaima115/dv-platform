import {
  buildEnvelope,
  EventTypes,
  type EventPublisher,
  type TransactionRunner,
  type UserPrincipal,
} from '@dv/shared';
import { CoreAction } from '../../domain/authorization/policy';
import { Company } from '../../domain/company/company';
import { ensureAllowed, userActor } from '../actor';
import { toCompanyView, type CompanyView } from '../company-view';
import type {
  CompanyRepository,
  MembershipRepository,
  UserAccountRepository,
} from '../ports/repositories';
import type { Clock, IdGenerator } from '../ports/runtime';

export interface CreateCompanyCommand {
  name: string;
  registrationNumber?: string | null;
  countryCode: string;
}

/**
 * One transaction: user account (first sighting), company in draft, owner membership and the
 * company_created outbox row. Any failure rolls all four back — data and event are never separated.
 */
export class CreateCompanyUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly accounts: UserAccountRepository,
    private readonly companies: CompanyRepository,
    private readonly memberships: MembershipRepository,
    private readonly events: EventPublisher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute(principal: UserPrincipal, command: CreateCompanyCommand): Promise<CompanyView> {
    return this.transactions.run(async (tx) => {
      const account = await this.accounts.ensure(tx, principal.subject);
      ensureAllowed(CoreAction.CREATE_COMPANY, userActor(principal, account), null);

      const { company, event } = Company.create({
        id: this.ids.next(),
        name: command.name,
        registrationNumber: command.registrationNumber ?? null,
        countryCode: command.countryCode,
        createdBy: account.id,
        now: this.clock.now(),
      });
      await this.companies.insert(tx, company);
      await this.memberships.add(tx, company.id, account.id, 'owner');
      await this.events.publish(
        tx,
        buildEnvelope({
          eventType: EventTypes.COMPANY_CREATED,
          aggregateId: company.id,
          data: {
            company_id: event.companyId,
            owner_user_id: event.ownerUserId,
            country_code: event.countryCode,
          },
        }),
      );
      return toCompanyView(company, 'owner');
    });
  }
}
