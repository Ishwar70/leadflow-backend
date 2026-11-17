import { z } from "zod";
import { LEAD_SOURCES, LEAD_STATUSES } from "../../models/Lead";
import { objectId, optionalObjectId } from "../../lib/http";

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");
const nullableDate = z
  .union([z.coerce.date(), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

export const LeadInputSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required").max(80),
    lastName: optionalText(80),
    email: z
      .union([z.string().trim().email("Enter a valid email"), z.literal("")])
      .optional()
      .transform((v) => v || null),
    phone: z
      .string()
      .trim()
      .max(30)
      .optional()
      .transform((v) => v || null)
      .refine((v) => !v || v.replace(/\D/g, "").length >= 7, "Enter a valid phone number"),
    companyName: optionalText(160),
    jobTitle: optionalText(120),
    source: z.enum(LEAD_SOURCES).default("other"),
    status: z.enum(LEAD_STATUSES).exclude(["converted"]).default("new"),
    ownerId: optionalObjectId,
    estimatedValue: z.coerce.number().min(0).max(1e12).default(0),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    city: optionalText(80),
    country: optionalText(80),
    nextFollowUpAt: nullableDate,
    allowDuplicate: z.boolean().optional(),
  })
  .strict();

export const LeadUpdateSchema = LeadInputSchema.partial().omit({ allowDuplicate: true }).strict();

export const LeadListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  ownerId: objectId.optional(),
  archived: z.enum(["true", "false"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z
    .enum(["createdAt", "-createdAt", "estimatedValue", "-estimatedValue", "firstName", "-firstName", "nextFollowUpAt", "-nextFollowUpAt"])
    .default("-createdAt"),
});

export const BulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), ids: z.array(objectId).min(1).max(500), ownerId: objectId }),
  z.object({
    action: z.literal("status"),
    ids: z.array(objectId).min(1).max(500),
    status: z.enum(LEAD_STATUSES).exclude(["converted"]),
  }),
  z.object({ action: z.literal("archive"), ids: z.array(objectId).min(1).max(500) }),
  z.object({ action: z.literal("restore"), ids: z.array(objectId).min(1).max(500) }),
]);

export const ConvertSchema = z.object({
  createCompany: z.boolean().default(true),
  companyName: z.string().trim().max(160).optional(),
  createDeal: z.boolean().default(true),
  dealTitle: z.string().trim().max(160).optional(),
  dealValue: z.coerce.number().min(0).optional(),
  pipelineId: objectId.optional(),
  expectedCloseDate: nullableDate,
});

export const IMPORT_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "companyName",
  "jobTitle",
  "source",
  "status",
  "estimatedValue",
  "city",
  "country",
  "tags",
] as const;

export const ImportSchema = z.object({
  csv: z.string().min(1).max(3_000_000),
  mapping: z.record(z.string(), z.enum(IMPORT_FIELDS).or(z.literal(""))),
  duplicateStrategy: z.enum(["skip", "create"]).default("skip"),
});
