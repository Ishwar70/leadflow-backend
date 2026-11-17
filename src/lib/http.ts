import type { Response } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { ValidationError } from "./errors";

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200) {
  return res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, undefined, 201);
}

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "_";
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    throw new ValidationError("Invalid request data", fieldErrors);
  }
  return result.data;
}

export const objectId = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v), { message: "Invalid id" });

export const optionalObjectId = z
  .union([objectId, z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

export function toObjectId(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ValidationError("Invalid id");
  return new Types.ObjectId(id);
}

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** For PATCH payloads: keep only keys the client actually sent, so schema defaults never overwrite stored values. */
export function onlyProvided<T extends Record<string, unknown>>(parsed: T, body: unknown): Partial<T> {
  const keys = body && typeof body === "object" ? Object.keys(body) : [];
  const out: Partial<T> = {};
  for (const k of keys) if (k in parsed) (out as Record<string, unknown>)[k] = parsed[k];
  return out;
}

export function paramId(value: unknown): string {
  return parse(objectId, value);
}
