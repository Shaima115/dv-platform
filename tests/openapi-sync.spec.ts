import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod, type Type } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { CompaniesController } from '../apps/core/src/api/controllers/companies.controller';
import { InternalEventsController as CoreEvents } from '../apps/core/src/api/controllers/internal-events.controller';
import { MeController } from '../apps/core/src/api/controllers/me.controller';
import {
  InternalEventsController as NotificationEvents,
  NotificationsController,
} from '../apps/notification/src/api/controllers';
import {
  AdminVerificationsController,
  InternalVerificationsController,
} from '../apps/verification/src/api/controllers';
import { HealthController } from '../packages/shared/src/nest/health.controller';

/** Every route registered on a controller, as "METHOD /path/{param}". */
function routes(controllers: Type<unknown>[]): string[] {
  const found: string[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      const path = `/${[base, sub].filter((p) => p && p !== '/').join('/')}`.replace(
        /:(\w+)/g,
        '{$1}',
      );
      found.push(`${RequestMethod[method]} ${path}`);
    }
  }
  return found.sort();
}

function documented(file: string): string[] {
  const spec = parse(readFileSync(join(__dirname, '../openapi', file), 'utf8')) as {
    openapi: string;
    paths: Record<string, Record<string, unknown>>;
  };
  expect(spec.openapi).toBe('3.1.0');
  return Object.entries(spec.paths)
    .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();
}

describe('OpenAPI specs match the implemented routes', () => {
  it('core', () => {
    expect(documented('core.yaml')).toEqual(
      routes([CompaniesController, MeController, CoreEvents, HealthController]),
    );
  });
  it('verification', () => {
    expect(documented('verification.yaml')).toEqual(
      routes([InternalVerificationsController, AdminVerificationsController, HealthController]),
    );
  });
  it('notification', () => {
    expect(documented('notification.yaml')).toEqual(
      routes([NotificationsController, NotificationEvents, HealthController]),
    );
  });
});
