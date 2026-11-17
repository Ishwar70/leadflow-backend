import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { audit, logActivity } from "../../lib/audit";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { created, escapeRegex, objectId, ok, onlyProvided, optionalObjectId, paramId, parse } from "../../lib/http";
import { buildSearchText, normalizeEmail, normalizePhone } from "../../lib/normalize";
import { can, requirePermission, resolveOwner, scopeFilter } from "../../lib/permissions";
import { ctxOf } from "../../middleware/auth";
import { Company, Contact } from "../../models/Contact";
import { Deal } from "../../models/Deal";
import { assertActiveMember } from "../leads/lead.service";

export const contactRouter = Router();

const ContactInput = z
  .object({
    firstName: z.string().trim().min(1, "First name is required").max(80),
    lastName: z.string().trim().max(80).default(""),
    email: z
      .union([z.string().trim().email("Enter a valid email"), z.literal("")])
      .optional()
      .transform((v) => v || null),
    phone: z.string().trim().max(30).optional().transform((v) => v || null),
    jobTitle: z.string().trim().max(120).default(""),
    companyId: optionalObjectId,
    ownerId: optionalObjectId,
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    city: z.string().trim().max(80).default(""),
    country: z.string().trim().max(80).default(""),
  })
  .strict();

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  companyId: objectId.optional(),
  ownerId: objectId.optional(),
  archived: z.enum(["true", "false"]).optional(),
});

async function assertCompany(workspaceId: Types.ObjectId, companyId: string | null | undefined) {
  if (!companyId) return null;
  const company = await Company.findOne({ _id: companyId, workspaceId }).select("name").lean();
  if (!company) throw new ValidationError("Company not found in this workspace", { companyId: "Unknown company" });
  return company;
}

async function searchTextFor(workspaceId: Types.ObjectId, c: Record<string, unknown>) {
  const company = c.companyId ? await Company.findOne({ _id: c.companyId, workspaceId }).select("name").lean() : null;
  return buildSearchText(c.firstName as string, c.lastName as string, c.email as string, c.phone as string, company?.name);
}

contactRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(ListQuery, req.query);
  const filter: Record<string, unknown> = { ...scopeFilter(ctx), archivedAt: q.archived === "true" ? { $ne: null } : null };
  if (q.q) filter.searchText = { $regex: escapeRegex(q.q.toLowerCase()) };
  if (q.companyId) filter.companyId = new Types.ObjectId(q.companyId);
  if (q.ownerId && can(ctx.role, "records:read_all")) filter.ownerId = new Types.ObjectId(q.ownerId);
  const [items, total] = await Promise.all([
    Contact.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("ownerId", "name email")
      .populate("companyId", "name")
      .lean(),
    Contact.countDocuments(filter),
  ]);
  ok(res, items, { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) });
});

contactRouter.post("/", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:create");
  const input = parse(ContactInput, req.body);
  const ownerId = resolveOwner(ctx, input.ownerId);
  await assertActiveMember(ctx.workspaceId, ownerId);
  await assertCompany(ctx.workspaceId, input.companyId);
  const contact = await Contact.create({
    ...input,
    ownerId,
    workspaceId: ctx.workspaceId,
    createdBy: ctx.userId,
    normalizedEmail: normalizeEmail(input.email),
    normalizedPhone: normalizePhone(input.phone),
    searchText: await searchTextFor(ctx.workspaceId, input),
  });
  const links: Array<{ entityType: "contact" | "company"; entityId: Types.ObjectId }> = [
    { entityType: "contact", entityId: contact._id },
  ];
  if (contact.companyId) links.push({ entityType: "company", entityId: contact.companyId });
  await logActivity(ctx, { type: "created", links, summary: `Contact ${contact.firstName} ${contact.lastName} created` });
  await audit(ctx, "contact.created", "contact", contact._id, { entityName: `${contact.firstName} ${contact.lastName}` });
  created(res, contact);
});

contactRouter.get("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  const contact = await Contact.findOne({ _id: paramId(req.params.id), ...scopeFilter(ctx) })
    .populate("ownerId", "name email")
    .populate("companyId", "name domain industry")
    .lean();
  if (!contact) throw new NotFoundError("Contact");
  const deals = await Deal.find({ workspaceId: ctx.workspaceId, contactId: contact._id, archivedAt: null })
    .select("title value currency status stageId pipelineId")
    .lean();
  ok(res, { ...contact, deals });
});

contactRouter.patch("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:update");
  const input = onlyProvided(parse(ContactInput.partial(), req.body), req.body);
  const contact = await Contact.findOne({ _id: paramId(req.params.id), ...scopeFilter(ctx) });
  if (!contact) throw new NotFoundError("Contact");
  if (input.companyId !== undefined) await assertCompany(ctx.workspaceId, input.companyId);
  const update: Record<string, unknown> = { ...input };
  if (input.ownerId !== undefined) {
    const owner = input.ownerId ? new Types.ObjectId(input.ownerId) : contact.ownerId;
    if (String(owner) !== String(contact.ownerId)) {
      requirePermission(ctx, "records:assign");
      await assertActiveMember(ctx.workspaceId, owner);
    }
    update.ownerId = owner;
  }
  Object.assign(contact, update);
  contact.normalizedEmail = normalizeEmail(contact.email);
  contact.normalizedPhone = normalizePhone(contact.phone);
  contact.searchText = await searchTextFor(ctx.workspaceId, contact.toObject());
  await contact.save();
  await audit(ctx, "contact.updated", "contact", contact._id, { entityName: `${contact.firstName} ${contact.lastName}`, after: input });
  ok(res, contact);
});

for (const action of ["archive", "restore"] as const) contactRouter.post(`/:id/${action}`, async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:archive");
  const archive = action === "archive";
  const contact = await Contact.findOneAndUpdate(
    { _id: paramId(req.params.id), ...scopeFilter(ctx) },
    { archivedAt: archive ? new Date() : null },
    { returnDocument: "after" },
  );
  if (!contact) throw new NotFoundError("Contact");
  await audit(ctx, `contact.${archive ? "archived" : "restored"}`, "contact", contact._id, {
    entityName: `${contact.firstName} ${contact.lastName}`,
  });
  ok(res, contact);
});
