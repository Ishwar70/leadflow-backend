import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import { created, objectId, ok, paramId, parse } from "../../lib/http";
import { can, requirePermission } from "../../lib/permissions";
import { resolveEntity } from "../../lib/related";
import { ctxOf } from "../../middleware/auth";
import { Activity, MANUAL_ACTIVITY_TYPES } from "../../models/Activity";
import { Lead } from "../../models/Lead";
import { ENTITY_TYPES } from "../../models/Task";

export const activityRouter = Router();

const ListQuery = z.object({
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: objectId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

activityRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(ListQuery, req.query);
  const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId };
  if (q.entityType && q.entityId) {
    await resolveEntity(ctx, q.entityType, q.entityId);
    filter.links = { $elemMatch: { entityType: q.entityType, entityId: new Types.ObjectId(q.entityId) } };
  } else if (!can(ctx.role, "records:read_all")) {
    filter.actorId = ctx.userId;
  }
  const [items, total] = await Promise.all([
    Activity.find(filter)
      .sort({ occurredAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("actorId", "name")
      .lean(),
    Activity.countDocuments(filter),
  ]);
  ok(res, items, { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) });
});

const ActivityInput = z.object({
  type: z.enum(MANUAL_ACTIVITY_TYPES),
  entityType: z.enum(ENTITY_TYPES),
  entityId: objectId,
  summary: z.string().trim().max(300).optional(),
  body: z.string().trim().max(10000).default(""),
  occurredAt: z.coerce.date().optional(),
});

const DEFAULT_SUMMARY: Record<string, string> = {
  note: "Note added",
  call: "Call logged",
  meeting: "Meeting logged",
  email: "Email logged",
  whatsapp: "WhatsApp conversation logged",
};

activityRouter.post("/", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:update");
  const input = parse(ActivityInput, req.body);
  if (input.type === "note" && !input.body) throw new ValidationError("Note text is required", { body: "Required" });
  const entity = await resolveEntity(ctx, input.entityType, input.entityId);
  const activity = await Activity.create({
    workspaceId: ctx.workspaceId,
    type: input.type,
    links: entity.links,
    actorId: ctx.userId,
    summary: input.summary || DEFAULT_SUMMARY[input.type],
    body: input.body,
    isSystem: false,
    occurredAt: input.occurredAt ?? new Date(),
  });
  if (input.type !== "note" && input.entityType === "lead") {
    await Lead.updateOne(
      { _id: entity.entityId, workspaceId: ctx.workspaceId, status: "new" },
      { status: "contacted" },
    );
    await Lead.updateOne({ _id: entity.entityId, workspaceId: ctx.workspaceId }, { lastContactedAt: activity.occurredAt });
  }
  await activity.populate("actorId", "name");
  created(res, activity);
});

activityRouter.patch("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(10000) }), req.body);
  const activity = await Activity.findOne({ _id: paramId(req.params.id), workspaceId: ctx.workspaceId });
  if (!activity) throw new NotFoundError("Activity");
  if (activity.isSystem) throw new ForbiddenError("System activities are immutable");
  if (String(activity.actorId) !== String(ctx.userId)) throw new ForbiddenError("Only the author can edit this entry");
  activity.body = body;
  await activity.save();
  ok(res, activity);
});

activityRouter.delete("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  const activity = await Activity.findOne({ _id: paramId(req.params.id), workspaceId: ctx.workspaceId });
  if (!activity) throw new NotFoundError("Activity");
  if (activity.isSystem) throw new ForbiddenError("System activities are immutable");
  const isAuthor = String(activity.actorId) === String(ctx.userId);
  if (!isAuthor && !can(ctx.role, "workspace:manage")) throw new ForbiddenError();
  await activity.deleteOne();
  ok(res, { deleted: true });
});
