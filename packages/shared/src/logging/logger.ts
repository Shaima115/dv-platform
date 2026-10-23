import pino, { type Logger } from 'pino';
import { currentContext } from '../tracing/context';

export type { Logger } from 'pino';

export interface LoggerOptions {
  service: string;
  environment: string;
  level?: string;
  /** Optional destination stream (tests). Defaults to stdout. */
  destination?: pino.DestinationStream;
}

/** Paths that must never reach a log line. */
export const REDACT_PATHS = [
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.authorization',
  'token',
  '*.token',
  'access_token',
  '*.access_token',
  'refresh_token',
  '*.refresh_token',
  'password',
  '*.password',
  'client_secret',
  '*.client_secret',
  'secret',
  '*.secret',
];

/**
 * Structured JSON logger. Each line carries service, environment and — when called inside a
 * request or event context — request_id, trace_id and span_id.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      base: { service: options.service, env: options.environment },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'msg',
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      mixin() {
        const context = currentContext();
        return context
          ? { request_id: context.requestId, trace_id: context.traceId, span_id: context.spanId }
          : {};
      },
    },
    options.destination,
  );
}

/** Extracts a safe description of an unknown error for logging (no stack for expected errors). */
export function describeError(error: unknown): { error_name: string; error_message: string } {
  if (error instanceof Error) {
    return { error_name: error.name, error_message: error.message };
  }
  return { error_name: 'NonError', error_message: String(error) };
}
