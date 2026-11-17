import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { audit, logActivity } from "../../lib/audit";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { created, escapeRegex, objectId, ok, onlyProvided, optionalObjectId, paramId, parse } from "../../lib/http";
import { buildSearchText } from "../../lib/normalize";
import { can, requirePermission, resolveOwner, scopeFilter } from "../../lib/permissions";
import { ctxOf } from "../../middleware/auth";
import { Company, Contact } from "../../models/Contact";
import { Deal, DealStageHistory, Pipeline } from "../../models/Deal";
import { assertActiveMember } from "../leads/lead.service";
import { dealLinks, getDealOrThrow, moveDealStage, stageOfType } from "./deal.service";

export const dealRouter = Router();

const nullableDate = z
  .union([z.coerce.date(), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

const DealInput = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(160),
    pipelineId: objectId.optional(),
    stageId: objectId.optional(),
    ownerId: optionalObjectId,
    companyId: optionalObjectId,
    contactId: optionalObjectId,
    value: z.coerce.number().min(0).max(1e12).default(0),
    probability: z.coerce.number().int().min(0).max(100).optional(),
    expectedCloseDate: nullableDate,
  })
  .strict();

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  pipelineId: objectId.optional(),
  stageId: objectId.optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  ownerId: objectId.optional(),
  companyId: objectId.optional(),
});

async function verifyRefs(workspaceId: Types.ObjectId, input: { companyId?: string | null; contactId?: string | null }) {
  const [company, contact] = await Promise.all([
    input.companyId ? Company.findOne({ _id: input.companyId, workspaceId }).select("name").lean() : null,
    input.contactId ? Contact.findOne({ _id: input.contactId, workspaceId }).select("firstName lastName").lean() : null,
  ]);
  if (input.companyId && !company) throw new ValidationError("Company not found", { companyId: "Unknown company" });
  if (input.contactId && !contact) throw new ValidationError("Contact not found", { contactId: "Unknown contact" });
  return { company, contact };
}

dealRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(ListQuery, req.query);
  const filter: Record<string, unknown> = { ...scopeFilter(ctx), archivedAt: null };
  if (q.pipelineId) filter.pipelineId = new Types.ObjectId(q.pipelineId);
  if (q.stageId) filter.stageId = new Types.ObjectId(q.stageId);
  if (q.status) filter.status = q.status;
  if (q.companyId) filter.companyId = new Types.ObjectId(q.companyId);
  if (q.ownerId && can(ctx.role, "records:read_all")) filter.ownerId = new Types.ObjectId(q.ownerId);
  if (q.q) filter.searchText = { $regex: escapeRegex(q.q.toLowerCase()) };
  const [items, total] = await Promise.all([
    Deal.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("ownerId", "name email")
      .populate("companyId", "name")
      .populate("contactId", "firstName lastName")
      .lean(),
    Deal.countDocuments(filter),
  ]);
  ok(res, items, { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) });
});

/** Kanban board: all open deals plus deals closed in the last 90 days for one pipeline. */
dealRouter.get("/board", async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(z.object({ pipelineId: objectId.optional(), ownerId: objectId.optional(), q: z.string().max(100).optional() }), req.query);
  const pipeline = q.pipelineId
    ? await Pipeline.findOne({ _id: q.pipelineId, workspaceId: ctx.workspaceId }).lean()
    : await Pipeline.findOne({ workspaceId: ctx.workspaceId }).sort({ isDefault: -1, createdAt: 1 }).lean();
  if (!pipeline) throw new NotFoundError("Pipeline");
  const filter: Record<string, unknown> = {
    ...scopeFilter(ctx),
    pipelineId: pipeline._id,
    archivedAt: null,
    $or: [{ status: "open" }, { closedAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } }],
  };
  if (q.ownerId && can(ctx.role, "records:read_all")) filter.ownerId = new Types.ObjectId(q.ownerId);
  if (q.q) filter.searchText = { $regex: escapeRegex(q.q.toLowerCase()) };
  const deals = await Deal.find(filter)
    .sort({ stageChangedAt: -1 })
    .limit(1000)
    .populate("ownerId", "name")
    .populate("companyId", "name")
    .lean();
  ok(res, { pipeline: { ...pipeline, stages: [...pipeline.stages].sort((a, b) => a.order - b.order) }, deals });
});

dealRouter.post("/", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:create");
  const input = parse(DealInput, req.body);
  const ownerId = resolveOwner(ctx, input.ownerId);
  await assertActiveMember(ctx.workspaceId, ownerId);
  const { company } = await verifyRefs(ctx.workspaceId, input);
  const pipeline = input.pipelineId
    ? await Pipeline.findOne({ _id: input.pipelineId, workspaceId: ctx.workspaceId }).lean()
    : await Pipeline.findOne({ workspaceId: ctx.workspaceId }).sort({ isDefault: -1, createdAt: 1 }).lean();
  if (!pipeline) throw new ValidationError("Pipeline not found", { pipelineId: "Unknown pipeline" });
  const openStages = pipeline.stages.filter((s) => s.type === "open").sort((a, b) => a.order - b.order);
  const stage = input.stageId ? openStages.find((s) => String(s._id) === input.stageId) : openStages[0];
  if (!stage) throw new ValidationError("New deals must start in an open stage", { stageId: "Invalid stage" });

  const deal = await Deal.create({
    ...input,
    workspaceId: ctx.workspaceId,
    pipelineId: pipeline._id,
    stageId: stage._id,
    ownerId,
    probability: input.probability ?? stage.probability,
    createdBy: ctx.userId,
    searchText: buildSearchText(input.title, company?.name),
  });
  await DealStageHistory.create({
    workspaceId: ctx.workspaceId,
    dealId: deal._id,
    toStageId: stage._id,
    toStageName: stage.name,
    changedBy: ctx.userId,
  });
  await logActivity(ctx, { type: "created", links: dealLinks(deal), summary: `Deal created in ${stage.name}` });
  await audit(ctx, "deal.created", "deal", deal._id, { entityName: deal.title });
  created(res, deal);
});

dealRouter.get("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  const deal = await Deal.findOne({ _id: paramId(req.params.id), ...scopeFilter(ctx) })
    .populate("ownerId", "name email")
    .populate("companyId", "name domain")
    .populate("contactId", "firstName lastName email phone")
    .lean();
  if (!deal) throw new NotFoundError("Deal");
  const [pipeline, history] = await Promise.all([
    Pipeline.findOne({ _id: deal.pipelineId, workspaceId: ctx.workspaceId }).lean(),
    DealStageHistory.find({ workspaceId: ctx.workspaceId, dealId: deal._id })
      .sort({ createdAt: -1 })
      .populate("changedBy", "name")
      .lean(),
  ]);
  ok(res, {
    ...deal,
    pipeline: pipeline ? { ...pipeline, stages: [...pipeline.stages].sort((a, b) => a.order - b.order) } : null,
    history,
  });
});

dealRouter.patch("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:update");
  const input = onlyProvided(parse(DealInput.partial().omit({ pipelineId: true, stageId: true }), req.body), req.body);
  const deal = await getDealOrThrow(ctx, paramId(req.params.id));
  const { company } = await verifyRefs(ctx.workspaceId, input);
  const before = { value: deal.value, ownerId: String(deal.ownerId), probability: deal.probability };
  const update: Record<string, unknown> = { ...input };
  if (input.ownerId !== undefined) {
    const owner = input.ownerId ? new Types.ObjectId(input.ownerId) : deal.ownerId;
    if (String(owner) !== String(deal.ownerId)) {
      requirePermission(ctx, "records:assign");
      await assertActiveMember(ctx.workspaceId, owner);
    }
    update.ownerId = owner;
  }
  if (input.probability !== undefined && input.probability !== deal.probability && !can(ctx.role, "pipeline:configure")) {
    throw new ValidationError("Only managers and above can override probability", { probability: "Not allowed" });
  }
  Object.assign(deal, update);
  const companyName = company?.name ?? (deal.companyId ? (await Company.findById(deal.companyId).select("name").lean())?.name : "");
  deal.searchText = buildSearchText(deal.title, companyName);
  await deal.save();
  if (String(deal.ownerId) !== before.ownerId) {
    await logActivity(ctx, { type: "assigned", links: dealLinks(deal), summary: "Deal reassigned" });
    await audit(ctx, "deal.assigned", "deal", deal._id, {
      entityName: deal.title,
      before: { ownerId: before.ownerId },
      after: { ownerId: String(deal.ownerId) },
    });
  }
  ok(res, deal);
});

const StageSchema = z.object({
  stageId: objectId,
  finalAmount: z.coerce.number().min(0).optional(),
  closedAt: nullableDate,
  lostReason: z.string().trim().max(300).optional(),
});

dealRouter.patch("/:id/stage", async (req, res) => {
  const ctx = ctxOf(req);
  ok(res, await moveDealStage(ctx, paramId(req.params.id), parse(StageSchema, req.body)));
});

dealRouter.post("/:id/won", async (req, res) => {
  const ctx = ctxOf(req);
  const id = paramId(req.params.id);
  const input = parse(StageSchema.omit({ stageId: true }), req.body);
  ok(res, await moveDealStage(ctx, id, { ...input, stageId: await stageOfType(ctx, id, "won") }));
});

dealRouter.post("/:id/lost", async (req, res) => {
  const ctx = ctxOf(req);
  const id = paramId(req.params.id);
  const input = parse(StageSchema.omit({ stageId: true }), req.body);
  ok(res, await moveDealStage(ctx, id, { ...input, stageId: await stageOfType(ctx, id, "lost") }));
});

dealRouter.post("/:id/archive", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:archive");
  const deal = await getDealOrThrow(ctx, paramId(req.params.id));
  deal.archivedAt = new Date();
  await deal.save();
  await audit(ctx, "deal.archived", "deal", deal._id, { entityName: deal.title });
  ok(res, deal);
});
