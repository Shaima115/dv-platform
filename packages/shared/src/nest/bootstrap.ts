import 'reflect-metadata';
import {
  type DynamicModule,
  type INestApplication,
  type LoggerService,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Logger } from 'pino';
import type { AppError } from '../errors/app-error';
import { AllExceptionsFilter } from './exception.filter';
import { requestContextMiddleware } from './request-context.middleware';

/** Routes Nest's own framework logs through pino. */
class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string) {
    this.logger.info({ nest_context: context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ nest_context: context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ nest_context: context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ nest_context: context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ nest_context: context }, String(message));
  }
}

export interface HttpServiceOptions {
  host: string;
  port: number;
  logger: Logger;
  /** Called on SIGTERM/SIGINT after the HTTP server stops accepting connections. */
  onShutdown?: () => Promise<void>;
  /** Translates service-specific (domain) errors into AppErrors for the error contract. */
  mapError?: (error: unknown) => AppError | undefined;
}

/** Creates the Nest app with request context, error contract, body limits and graceful shutdown. */
export async function startHttpService(
  module: Type<unknown> | DynamicModule,
  options: HttpServiceOptions,
): Promise<INestApplication> {
  const app = await NestFactory.create(module, {
    logger: new PinoNestLogger(options.logger),
    bodyParser: false,
  });
  const express = await import('express');
  app.use(requestContextMiddleware(options.logger));
  app.use(express.json({ limit: '64kb', type: ['application/json', 'application/*+json'] }));
  app.useGlobalFilters(new AllExceptionsFilter(options.logger, options.mapError));
  const http = app.getHttpAdapter().getInstance() as {
    disable(name: string): void;
    set(name: string, value: unknown): void;
  };
  http.disable('x-powered-by');
  http.set('trust proxy', 'loopback');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.logger.info({ operation: 'shutdown', signal }, 'shutting down');
    try {
      await app.close();
      await options.onShutdown?.();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(options.port, options.host);
  options.logger.info(
    { operation: 'startup', host: options.host, port: options.port },
    'service listening',
  );
  return app;
}
