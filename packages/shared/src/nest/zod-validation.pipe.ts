import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/** Validates and strips a request body/query/param with a zod schema; ZodError maps to 400. */
@Injectable()
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    return this.schema.parse(value) as z.infer<S>;
  }
}
