import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  AuthGuard,
  checkDatabase,
  HealthController,
  LOGGER,
  OutboxEventPublisher,
  PgTransactionRunner,
  READINESS_CHECK,
  TOKEN_VERIFIER,
  TransactionalInbox,
  type Logger,
  type TokenVerifier,
} from '@dv/shared';
import type { Pool } from 'pg';
import { PgCompanyRepository } from './adapters/persistence/pg-company.repository';
import { PgMembershipRepository } from './adapters/persistence/pg-membership.repository';
import { PgUserAccountRepository } from './adapters/persistence/pg-user-account.repository';
import { systemClock, uuidV7Generator } from './adapters/runtime';
import type { VerificationGateway } from './application/ports/verification-gateway';
import { AddMemberUseCase } from './application/use-cases/add-member';
import { CreateCompanyUseCase } from './application/use-cases/create-company';
import { GetCompanyUseCase } from './application/use-cases/get-company';
import { GetMeUseCase } from './application/use-cases/get-me';
import { HandleVerificationCompleted } from './application/use-cases/handle-verification-completed';
import { ListMyCompaniesUseCase } from './application/use-cases/list-my-companies';
import { RequestVerificationUseCase } from './application/use-cases/request-verification';
import { CompaniesController } from './api/controllers/companies.controller';
import { InternalEventsController } from './api/controllers/internal-events.controller';
import { MeController } from './api/controllers/me.controller';
import {
  ADD_MEMBER,
  CREATE_COMPANY,
  GET_COMPANY,
  GET_ME,
  INBOX,
  LIST_MY_COMPANIES,
  REQUEST_VERIFICATION,
  VERIFICATION_COMPLETED_HANDLER,
} from './api/tokens';

export interface CoreDependencies {
  pool: Pool;
  logger: Logger;
  verifier: TokenVerifier;
  gateway: VerificationGateway;
  submissionClaimMs: number;
}

/** Composition root: wires adapters into the framework-free use cases. */
@Module({})
export class CoreModule {
  static forRoot(deps: CoreDependencies): DynamicModule {
    const transactions = new PgTransactionRunner(deps.pool);
    const accounts = new PgUserAccountRepository(uuidV7Generator);
    const companies = new PgCompanyRepository();
    const memberships = new PgMembershipRepository();
    const publisher = new OutboxEventPublisher('core');

    return {
      module: CoreModule,
      controllers: [CompaniesController, MeController, InternalEventsController, HealthController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: LOGGER, useValue: deps.logger },
        { provide: READINESS_CHECK, useValue: () => checkDatabase(deps.pool) },
        {
          provide: CREATE_COMPANY,
          useValue: new CreateCompanyUseCase(
            transactions,
            accounts,
            companies,
            memberships,
            publisher,
            systemClock,
            uuidV7Generator,
          ),
        },
        {
          provide: GET_COMPANY,
          useValue: new GetCompanyUseCase(transactions, accounts, companies, memberships),
        },
        {
          provide: LIST_MY_COMPANIES,
          useValue: new ListMyCompaniesUseCase(transactions, accounts, companies),
        },
        { provide: GET_ME, useValue: new GetMeUseCase(transactions, accounts) },
        {
          provide: ADD_MEMBER,
          useValue: new AddMemberUseCase(transactions, accounts, companies, memberships),
        },
        {
          provide: REQUEST_VERIFICATION,
          useValue: new RequestVerificationUseCase(
            transactions,
            accounts,
            companies,
            memberships,
            deps.gateway,
            systemClock,
            uuidV7Generator,
            { submissionClaimMs: deps.submissionClaimMs },
            deps.logger,
          ),
        },
        {
          provide: VERIFICATION_COMPLETED_HANDLER,
          useValue: new HandleVerificationCompleted(companies, memberships, publisher, systemClock),
        },
        {
          provide: INBOX,
          useValue: new TransactionalInbox('core', 'core', transactions, deps.logger),
        },
      ],
    };
  }
}
