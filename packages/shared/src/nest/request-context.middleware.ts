import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { createContext, runWithContext } from '../tracing/context';

/**
 * Establishes the request context (request id + W3C trace) for everything that runs for this request,
 * echoes the request id to the caller, and writes one access log line on completion.
 */
export function requestContextMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const context = createContext({
      requestId: header('x-request-id'),
      traceparent: header('traceparent'),
    });
    res.setHeader('x-request-id', context.requestId);
    res.setHeader('traceparent', context.traceparent);
    const started = process.hrtime.bigint();
    runWithContext(context, () => {
      res.on('finish', () => {
        runWithContext(context, () => {
          logger.info(
            {
              operation: 'http_request',
              method: req.method,
              path: req.path,
              status_code: res.statusCode,
              duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
            },
            'request completed',
          );
        });
      });
      next();
    });
  };
}
