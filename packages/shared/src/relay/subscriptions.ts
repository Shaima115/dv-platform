import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { EVENT_TYPE_RE } from '../events/envelope';

const subscriberSchema = z
  .object({
    /** Stable subscriber name, part of the delivery row's unique key. */
    name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    url: z
      .string()
      .url()
      .refine((url) => new URL(url).hostname.endsWith('.internal'), {
        message: 'subscriber URLs must go through the Nginx internal listener (*.internal)',
      }),
  })
  .strict();

export const subscriptionFileSchema = z
  .object({
    producer: z.string().min(1),
    subscriptions: z.record(z.string().regex(EVENT_TYPE_RE), z.array(subscriberSchema)),
  })
  .strict()
  .superRefine((file, ctx) => {
    for (const [type, subscribers] of Object.entries(file.subscriptions)) {
      const names = subscribers.map((subscriber) => subscriber.name);
      if (new Set(names).size !== names.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate subscriber for ${type}` });
      }
    }
  });

export type SubscriptionFile = z.infer<typeof subscriptionFileSchema>;
export type Subscriber = z.infer<typeof subscriberSchema>;

export class SubscriptionTable {
  constructor(private readonly file: SubscriptionFile) {}

  static load(path: string): SubscriptionTable {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return new SubscriptionTable(subscriptionFileSchema.parse(raw));
  }

  subscribersFor(eventType: string): readonly Subscriber[] {
    return this.file.subscriptions[eventType] ?? [];
  }

  get producer(): string {
    return this.file.producer;
  }
}
