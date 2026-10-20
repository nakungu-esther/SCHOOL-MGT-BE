import { z } from "zod";

function emptyToNull(value: unknown): unknown {
  if (value === "" || value === undefined) return null;
  return value;
}

export const schoolSettingsSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  addressLine1: z.preprocess(emptyToNull, z.string().max(255).nullable().optional()),
  addressLine2: z.preprocess(emptyToNull, z.string().max(255).nullable().optional()),
  city: z.preprocess(emptyToNull, z.string().max(120).nullable().optional()),
  country: z.preprocess(emptyToNull, z.string().max(120).nullable().optional()),
  phone: z.preprocess(emptyToNull, z.string().max(40).nullable().optional()),
  contactEmail: z.preprocess(
    emptyToNull,
    z.union([z.string().email(), z.null()]).optional(),
  ),
  timezone: z.string().min(1).max(64).optional(),
  motto: z.preprocess(emptyToNull, z.string().max(255).nullable().optional()),
  academicYear: z.preprocess(emptyToNull, z.string().max(32).nullable().optional()),
  term: z.preprocess(emptyToNull, z.string().max(32).nullable().optional()),
  currency: z.string().min(3).max(8).optional(),
});

export type SchoolSettingsInput = z.infer<typeof schoolSettingsSchema>;
