import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { audit, logActivity } from "../../lib/audit";
import { NotFoundError } from "../../lib/errors";
import { created, escapeRegex, objectId, ok, onlyProvided, optionalObjectId, paramId, parse } from "../../lib/http";
import { buildSearchText } from "../../lib/normalize";
import { can, requirePermission, resolveOwner, scopeFilter } from "../../lib/permissions";
import { ctxOf } from "../../middleware/auth";
import { Company, Contact } from "../../models/Contact";
import { Deal } from "../../models/Deal";
import { assertActiveMember } from "../leads/lead.service";

export const companyRouter = Router();

const CompanyInput = z
  .object({
    name: z.string().trim().min(1, "Company name is required").max(160),
    domain: z.string().trim().toLowerCase().max(120).default(""),
    industry: z.string().trim().max(80).default(""),
    size: z.string().trim().max(20).default(""),
    phone: z.string().trim().max(30).default(""),
    address: z.string().trim().max(240).default(""),
    city: z.string().trim().max(80).default(""),
    country: z.string().trim().max(80).default(""),
    ownerId: optionalObjectId,
  })
  .strict();

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  industry: z.string().trim().max(80).optional(),
  ownerId: objectId.optional(),
  archived: z.enum(["true", "false"]).optional(),
});

companyRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(ListQuery, req.query);
  const filter: Record<string, unknown> = { ...scopeFilter(ctx), archivedAt: q.archived === "true" ? { $ne: null } : null };
  if (q.q) filter.searchText = { $regex: escapeRegex(q.q.toLowerCase()) };
  if (q.industry) filter.industry = q.industry;
  if (q.ownerId && can(ctx.role, "records:read_all")) filter.ownerId = new Types.ObjectId(q.ownerId);
  const [items, total] = await Promise.all([
    Company.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("ownerId", "name email")
      .lean(),
    Company.countDocuments(filter),
  ]);
  const ids = items.map((c) => c._id);
  const [contactCounts, dealStats] = await Promise.all([
    Contact.aggregate([
      { $match: { workspaceId: ctx.workspaceId, companyId: { $in: ids }, archivedAt: null } },
      { $group: { _id: "$companyId", count: { $sum: 1 } } },
    ]),
    Deal.aggregate([
      { $match: { workspaceId: ctx.workspaceId, companyId: { $in: ids }, archivedAt: null } },
      {
        $group: {
          _id: "$companyId",
          count: { $sum: 1 },
          openValue: { $sum: { $cond: [{ $eq: ["$status", "open"] }, "$value", 0] } },
        },
      },
    ]),
  ]);
  const enriched = items.map((c) => ({
    ...c,
    contactCount: contactCounts.find((x) => String(x._id) === String(c._id))?.count ?? 0,
    dealCount: dealStats.find((x) => String(x._id) === String(c._id))?.count ?? 0,
    openDealValue: dealStats.find((x) => String(x._id) === String(c._id))?.openValue ?? 0,
  }));
  ok(res, enriched, { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) });
});

companyRouter.post("/", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:create");
  const input = parse(CompanyInput, req.body);
  const ownerId = resolveOwner(ctx, input.ownerId);
  await assertActiveMember(ctx.workspaceId, ownerId);
  const company = await Company.create({
    ...input,
    ownerId,
    workspaceId: ctx.workspaceId,
    createdBy: ctx.userId,
    searchText: buildSearchText(input.name, input.domain, input.city),
  });
  await logActivity(ctx, {
    type: "created",
    links: [{ entityType: "company", entityId: company._id }],
    summary: `Company ${company.name} created`,
  });
  await audit(ctx, "company.created", "company", company._id, { entityName: company.name });
  created(res, company);
});

companyRouter.get("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  const company = await Company.findOne({ _id: paramId(req.params.id), ...scopeFilter(ctx) })
    .populate("ownerId", "name email")
    .lean();
  if (!company) throw new NotFoundError("Company");
  const [contacts, deals] = await Promise.all([
    Contact.find({ workspaceId: ctx.workspaceId, companyId: company._id, archivedAt: null })
      .select("firstName lastName email phone jobTitle")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
    Deal.find({ workspaceId: ctx.workspaceId, companyId: company._id, archivedAt: null })
      .select("title value currency status stageId pipelineId expectedCloseDate")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
  ]);
  ok(res, { ...company, contacts, deals });
});

companyRouter.patch("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:update");
  const input = onlyProvided(parse(CompanyInput.partial(), req.body), req.body);
  const company = await Company.findOne({ _id: paramId(req.params.id), ...scopeFilter(ctx) });
  if (!company) throw new NotFoundError("Company");
  const update: Record<string, unknown> = { ...input };
  if (input.ownerId !== undefined) {
    const owner = input.ownerId ? new Types.ObjectId(input.ownerId) : company.ownerId;
    if (String(owner) !== String(company.ownerId)) {
      requirePermission(ctx, "records:assign");
      await assertActiveMember(ctx.workspaceId, owner);
    }
    update.ownerId = owner;
  }
  Object.assign(company, update);
  company.searchText = buildSearchText(company.name, company.domain, company.city);
  await company.save();
  await audit(ctx, "company.updated", "company", company._id, { entityName: company.name, after: input });
  ok(res, company);
});

for (const action of ["archive", "restore"] as const) companyRouter.post(`/:id/${action}`, async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:archive");
  const archive = action === "archive";
  const company = await Company.findOneAndUpdate(
    { _id: paramId(req.params.id), ...scopeFilter(ctx) },
    { archivedAt: archive ? new Date() : null },
    { returnDocument: "after" },
  );
  if (!company) throw new NotFoundError("Company");
  await audit(ctx, `company.${archive ? "archived" : "restored"}`, "company", company._id, { entityName: company.name });
  ok(res, company);
});
