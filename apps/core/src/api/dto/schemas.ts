import { z } from 'zod';

export const createCompanySchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    registrationNumber: z.string().trim().min(1).max(64).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, upper case'),
  })
  .strict();
export type CreateCompanyDto = z.infer<typeof createCompanySchema>;

export const addMemberSchema = z
  .object({
    userAccountId: z.string().uuid(),
    role: z.enum(['representative', 'employee']),
  })
  .strict();
export type AddMemberDto = z.infer<typeof addMemberSchema>;

export const uuidParam = z.string().uuid();

export const pageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type PageQuery = z.infer<typeof pageQuerySchema>;
