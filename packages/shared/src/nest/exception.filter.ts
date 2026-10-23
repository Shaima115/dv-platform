import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { AppError, ErrorCodes } from '../errors/app-error';
import { describeError } from '../logging/logger';
import { currentContext } from '../tracing/context';

export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  requestId?: string;
  details?: Readonly<Record<string, unknown>>;
}

const HTTP_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: ErrorCodes.NOT_FOUND,
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/** Maps every error to the stable JSON error contract. Never leaks stacks, SQL or token details. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  /** `mapError` lets a service translate its own domain errors into AppErrors. */
  constructor(
    private readonly logger: Logger,
    private readonly mapError?: (error: unknown) => AppError | undefined,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = currentContext()?.requestId;
    const body = this.toBody(exception, requestId);

    if (body.statusCode >= 500) {
      this.logger.error(
        {
          operation: 'http_error',
          status_code: body.statusCode,
          error_code: body.code,
          ...describeError(exception),
          stack: exception instanceof Error ? exception.stack : undefined,
        },
        'request failed',
      );
    } else {
      this.logger.info(
        { operation: 'http_error', status_code: body.statusCode, error_code: body.code },
        'request rejected',
      );
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(original: unknown, requestId: string | undefined): ErrorBody {
    const exception = this.mapError?.(original) ?? original;
    if (exception instanceof AppError) {
      return {
        statusCode: exception.statusCode,
        code: exception.code,
        message: exception.message,
        requestId,
        ...(exception.details ? { details: exception.details } : {}),
      };
    }
    if (exception instanceof ZodError) {
      return {
        statusCode: 400,
        code: ErrorCodes.VALIDATION_FAILED,
        message: 'The request is invalid.',
        requestId,
        details: {
          issues: exception.issues.map(
            (issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`,
          ),
        },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        statusCode: status,
        code: HTTP_CODES[status] ?? (status >= 500 ? ErrorCodes.INTERNAL_ERROR : 'HTTP_ERROR'),
        message: status >= 500 ? 'Internal server error.' : exception.message,
        requestId,
      };
    }
    return {
      statusCode: 500,
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Internal server error.',
      requestId,
    };
  }
}
