import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  AuthGuard,
  checkDatabase,
  HealthController,
  OutboxEventPublisher,
  PgTransactionRunner,
  READINESS_CHECK,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '@dv/shared';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { PgVerificationRepository } from './adapters/pg-verification.repository';
import {
  AdminVerificationsController,
  CREATE,
  DECIDE,
  GET,
  InternalVerificationsController,
} from './api/controllers';
import {
  CreateVerificationRequestUseCase,
  DecideVerificationUseCase,
  GetVerificationRequestUseCase,
} from './application/use-cases';

@Module({})
export class VerificationModule {
  static forRoot(deps: { pool: Pool; verifier: TokenVerifier }): DynamicModule {
    const transactions = new PgTransactionRunner(deps.pool);
    const repository = new PgVerificationRepository();
    const clock = { now: () => new Date() };
    const ids = { next: () => uuidv7() };
    return {
      module: VerificationModule,
      controllers: [
        InternalVerificationsController,
        AdminVerificationsController,
        HealthController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: READINESS_CHECK, useValue: () => checkDatabase(deps.pool) },
        {
          provide: CREATE,
          useValue: new CreateVerificationRequestUseCase(transactions, repository, clock, ids),
        },
        { provide: GET, useValue: new GetVerificationRequestUseCase(transactions, repository) },
        {
          provide: DECIDE,
          useValue: new DecideVerificationUseCase(
            transactions,
            repository,
            new OutboxEventPublisher('compliance'),
            clock,
          ),
        },
      ],
    };
  }
}
