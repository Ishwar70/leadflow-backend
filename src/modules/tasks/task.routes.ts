import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { audit, logActivity, notify } from "../../lib/audit";
import { ForbiddenError, NotFoundError } from "../../lib/errors";
import { created, objectId, ok, onlyProvided, optionalObjectId, paramId, parse } from "../../lib/http";
import { can, requirePermission, resolveOwner, scopeFilter } from "../../lib/permissions";
import { resolveEntity } from "../../lib/related";
import { ctxOf } from "../../middleware/auth";
import { Lead } from "../../models/Lead";
import { ENTITY_TYPES, Task } from "../../models/Task";
import { assertActiveMember } from "../leads/lead.service";

export const taskRouter = Router();

const TaskInput = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(200),
    description: z.string().trim().max(4000).default(""),
    type: z.enum(["call", "email", "meeting", "follow_up", "general"]).default("general"),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    dueAt: z.coerce.date({ message: "Due date is required" }),
    assignedTo: optionalObjectId,
    relatedType: z.enum(ENTITY_TYPES).nullable().optional(),
    relatedId: optionalObjectId,
  })
  .strict();

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  view: z.enum(["today", "upcoming", "overdue", "completed", "open", "all"]).default("open"),
  assignedTo: objectId.optional(),
  relatedType: z.enum(ENTITY_TYPES).optional(),
  relatedId: objectId.optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
});

taskRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(ListQuery, req.query);
  const filter: Record<string, unknown> = scopeFilter(ctx, "assignedTo");
  if (q.assignedTo && can(ctx.role, "records:read_all")) filter.assignedTo = new Types.ObjectId(q.assignedTo);
  if (q.relatedType && q.relatedId) {
    await resolveEntity(ctx, q.relatedType, q.relatedId);
    filter.relatedType = q.relatedType;
    filter.relatedId = new Types.ObjectId(q.relatedId);
    delete filter.assignedTo;
    filter.workspaceId = ctx.workspaceId;
  }
  if (q.priority) filter.priority = q.priority;

  // tzOffset is minutes from Date#getTimezoneOffset() so "today" matches the user's local day.
  const now = new Date();
  const local = new Date(now.getTime() - q.tzOffset * 60000);
  const startOfDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + q.tzOffset * 60000);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  let sort: Record<string, 1 | -1> = { dueAt: 1 };
  switch (q.view) {
    case "today":
      Object.assign(filter, { status: "open", dueAt: { $gte: startOfDay, $lt: endOfDay } });
      break;
    case "upcoming":
      Object.assign(filter, { status: "open", dueAt: { $gte: endOfDay } });
      break;
    case "overdue":
      Object.assign(filter, { status: "open", dueAt: { $lt: now } });
      break;
    case "completed":
      Object.assign(filter, { status: "completed" });
      sort = { completedAt: -1 };
      break;
    case "open":
      Object.assign(filter, { status: "open" });
      break;
  }
  const [items, total] = await Promise.all([
    Task.find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("assignedTo", "name email")
      .lean(),
    Task.countDocuments(filter),
  ]);
  ok(res, items, { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) });
});

taskRouter.get("/counts", async (req, res) => {
  const ctx = ctxOf(req);
  const base: Record<string, unknown> = { ...scopeFilter(ctx, "assignedTo"), status: "open" };
  const now = new Date();
  const [open, overdue] = await Promise.all([
    Task.countDocuments(base),
    Task.countDocuments({ ...base, dueAt: { $lt: now } }),
  ]);
  ok(res, { open, overdue });
});

taskRouter.post("/", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:create");
  const input = parse(TaskInput, req.body);
  const assignedTo = resolveOwner(ctx, input.assignedTo);
  await assertActiveMember(ctx.workspaceId, assignedTo);
  let relatedName = "";
  if (input.relatedType && input.relatedId) {
    relatedName = (await resolveEntity(ctx, input.relatedType, input.relatedId)).name;
  }
  const task = await Task.create({
    ...input,
    relatedType: input.relatedId ? input.relatedType : null,
    relatedId: input.relatedId || null,
    relatedName,
    assignedTo,
    workspaceId: ctx.workspaceId,
    createdBy: ctx.userId,
  });
  if (input.relatedType === "lead" && input.relatedId) {
    await Lead.updateOne(
      { _id: input.relatedId, workspaceId: ctx.workspaceId, $or: [{ nextFollowUpAt: null }, { nextFollowUpAt: { $gt: task.dueAt } }] },
      { nextFollowUpAt: task.dueAt },
    );
  }
  if (String(assignedTo) !== String(ctx.userId)) {
    await notify({
      workspaceId: ctx.workspaceId,
      userId: assignedTo,
      type: "task_due",
      title: `New task: ${task.title}`,
      body: `Due ${task.dueAt.toISOString()}`,
      link: "/tasks",
    });
  }
  created(res, task);
});

async function loadTask(ctx: ReturnType<typeof ctxOf>, id: string) {
  const task = await Task.findOne({ _id: id, ...scopeFilter(ctx, "assignedTo") });
  if (!task) throw new NotFoundError("Task");
  return task;
}

taskRouter.patch("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:update");
  const input = onlyProvided(parse(TaskInput.partial().omit({ relatedType: true, relatedId: true }), req.body), req.body);
  const task = await loadTask(ctx, paramId(req.params.id));
  if (input.assignedTo !== undefined) {
    const assignee = input.assignedTo ? new Types.ObjectId(input.assignedTo) : task.assignedTo;
    if (String(assignee) !== String(task.assignedTo)) {
      requirePermission(ctx, "records:assign");
      await assertActiveMember(ctx.workspaceId, assignee);
    }
    Object.assign(task, { assignedTo: assignee });
  }
  const { assignedTo: _ignored, ...rest } = input;
  Object.assign(task, rest);
  if (input.dueAt) task.reminderSentAt = null;
  await task.save();
  ok(res, task);
});

taskRouter.patch("/:id/complete", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:update");
  const task = await loadTask(ctx, paramId(req.params.id));
  if (task.status !== "completed") {
    task.status = "completed";
    task.completedAt = new Date();
    await task.save();
    if (task.relatedType && task.relatedId) {
      try {
        const entity = await resolveEntity({ ...ctx, role: "owner" }, task.relatedType, String(task.relatedId));
        await logActivity(ctx, { type: "task_completed", links: entity.links, summary: `Task completed: ${task.title}` });
        if (task.relatedType === "lead" && ["call", "email", "meeting"].includes(task.type)) {
          await Lead.updateOne({ _id: task.relatedId, workspaceId: ctx.workspaceId }, { lastContactedAt: new Date() });
        }
      } catch {
        // Related record may have been removed; completion still succeeds.
      }
    }
  }
  ok(res, task);
});

taskRouter.patch("/:id/reopen", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:update");
  const task = await loadTask(ctx, paramId(req.params.id));
  task.status = "open";
  task.completedAt = null;
  await task.save();
  ok(res, task);
});

taskRouter.delete("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  const task = await loadTask(ctx, paramId(req.params.id));
  if (!can(ctx.role, "records:archive") && String(task.createdBy) !== String(ctx.userId)) throw new ForbiddenError();
  if (ctx.role === "viewer") throw new ForbiddenError();
  await task.deleteOne();
  await audit(ctx, "task.deleted", "task", task._id, { entityName: task.title });
  ok(res, { deleted: true });
});
