import { z } from "zod";

export type Audience = "admin" | "reviewer" | "candidate" | "all";

export const HelpEntrySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  key: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9_]+(\.[a-z0-9_]+)*$/,
      "help_id segments must be lowercase [a-z0-9_], dot-separated",
    ),
  audience: z.enum(["admin", "reviewer", "candidate", "all"]),
  locale: z.string().min(2), // e.g. 'en', 'hi-IN'
  shortText: z.string().min(1).max(120),
  longMd: z.string().nullable(),
  version: z.number().int().min(1),
  status: z.enum(["active", "archived"]),
  updatedAt: z.string(), // ISO
});

export type HelpEntry = z.infer<typeof HelpEntrySchema>;

export const HelpReadEnvelopeSchema = HelpEntrySchema.omit({
  id: true,
  tenantId: true,
  version: true,
  status: true,
  updatedAt: true,
}).extend({ _fallback: z.boolean().optional() });

export type HelpReadEnvelope = z.infer<typeof HelpReadEnvelopeSchema>;

export const UpsertHelpInputSchema = z.object({
  audience: z.enum(["admin", "reviewer", "candidate", "all"]),
  locale: z.string().default("en"),
  shortText: z.string().min(1).max(120),
  longMd: z.string().nullable().optional(),
});

export type UpsertHelpInput = z.infer<typeof UpsertHelpInputSchema>;
