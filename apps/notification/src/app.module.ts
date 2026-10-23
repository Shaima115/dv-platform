import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  AuthGuard,
  checkDatabase,
  HealthController,
  PgTransactionRunner,
  READINESS_CHECK,
  TOKEN_VERIFIER,
  TransactionalInbox,
  type Logger,
  type TokenVerifier,
} from '@dv/shared';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { FileFaultInjector } from './adapters/file-fault-injector';
import { PgNotificationRepository } from './adapters/pg-notification.repository';
import {
  HANDLER,
  INBOX,
  InternalEventsController,
  LIST,
  NotificationsController,
} from './api/controllers';
import { HandleCompanyApproved, ListMyNotificationsUseCase } from './application/use-cases';

@Module({})
export class NotificationModule {
  static forRoot(deps: {
    pool: Pool;
    verifier: TokenVerifier;
    logger: Logger;
    faultFile?: string;
  }): DynamicModule {
    const transactions = new PgTransactionRunner(deps.pool);
    const repository = new PgNotificationRepository();
    const faults = deps.faultFile ? new FileFaultInjector(deps.faultFile) : undefined;
    return {
      module: NotificationModule,
      controllers: [NotificationsController, InternalEventsController, HealthController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: READINESS_CHECK, useValue: () => checkDatabase(deps.pool) },
        { provide: LIST, useValue: new ListMyNotificationsUseCase(transactions, repository) },
        {
          provide: HANDLER,
          useValue: new HandleCompanyApproved(
            repository,
            { next: () => uuidv7() },
            { now: () => new Date() },
            deps.logger,
            faults,
          ),
        },
        {
          provide: INBOX,
          useValue: new TransactionalInbox(
            'notification',
            'notification',
            transactions,
            deps.logger,
          ),
        },
      ],
    };
  }
}
