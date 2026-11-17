import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { audit } from "../../lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { created, objectId, ok, paramId, parse } from "../../lib/http";
import { requirePermission } from "../../lib/permissions";
import { ctxOf } from "../../middleware/auth";
import { Deal, DEFAULT_STAGES, Pipeline } from "../../models/Deal";

export const pipelineRouter = Router();

const StageInput = z.object({
  _id: objectId.optional(),
  name: z.string().trim().min(1, "Stage name is required").max(60),
  probability: z.coerce.number().int().min(0).max(100),
  type: z.enum(["open", "won", "lost"]).default("open"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#6366f1"),
});

const PipelineInput = z.object({
  name: z.string().trim().min(1, "Pipeline name is required").max(80),
  stages: z
    .array(StageInput)
    .min(2, "A pipeline needs at least two stages")
    .max(15)
    .refine((s) => s.filter((x) => x.type === "won").length === 1, "Exactly one Won stage is required")
    .refine((s) => s.filter((x) => x.type === "lost").length === 1, "Exactly one Lost stage is required")
    .refine((s) => s.some((x) => x.type === "open"), "At least one open stage is required"),
});

pipelineRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const pipelines = await Pipeline.find({ workspaceId: ctx.workspaceId }).sort({ isDefault: -1, createdAt: 1 }).lean();
  ok(
    res,
    pipelines.map((p) => ({ ...p, stages: [...p.stages].sort((a, b) => a.order - b.order) })),
  );
});

pipelineRouter.post("/", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "pipeline:configure");
  const input = parse(
    PipelineInput.partial({ stages: true }),
    req.body,
  );
  const stages = (input.stages ?? DEFAULT_STAGES.map((s) => ({ ...s }))).map((s, i) => ({ ...s, _id: undefined, order: i }));
  const hasAny = await Pipeline.exists({ workspaceId: ctx.workspaceId });
  const pipeline = await Pipeline.create({ workspaceId: ctx.workspaceId, name: input.name, stages, isDefault: !hasAny });
  await audit(ctx, "pipeline.created", "pipeline", pipeline._id, { entityName: pipeline.name });
  created(res, pipeline);
});

pipelineRouter.patch("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "pipeline:configure");
  const input = parse(PipelineInput, req.body);
  const pipeline = await Pipeline.findOne({ _id: paramId(req.params.id), workspaceId: ctx.workspaceId });
  if (!pipeline) throw new NotFoundError("Pipeline");

  const keptIds = new Set(input.stages.filter((s) => s._id).map((s) => s._id));
  const removed = pipeline.stages.filter((s) => !keptIds.has(String(s._id)));
  for (const stage of removed) {
    const count = await Deal.countDocuments({ workspaceId: ctx.workspaceId, pipelineId: pipeline._id, stageId: stage._id });
    if (count) {
      throw new ConflictError("STAGE_IN_USE", `Stage "${stage.name}" has ${count} deal(s). Move them before deleting the stage.`);
    }
  }
  const unknown = input.stages.find((s) => s._id && !pipeline.stages.some((x) => String(x._id) === s._id));
  if (unknown) throw new ValidationError("Unknown stage id");

  const before = pipeline.stages.map((s) => s.name);
  pipeline.name = input.name;
  pipeline.set(
    "stages",
    input.stages.map((s, i) => ({ ...s, _id: s._id ? new Types.ObjectId(s._id) : new Types.ObjectId(), order: i })),
  );
  await pipeline.save();
  await audit(ctx, "pipeline.updated", "pipeline", pipeline._id, {
    entityName: pipeline.name,
    before: { stages: before },
    after: { stages: input.stages.map((s) => s.name) },
  });
  ok(res, pipeline);
});

pipelineRouter.post("/:id/default", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "pipeline:configure");
  const pipeline = await Pipeline.findOne({ _id: paramId(req.params.id), workspaceId: ctx.workspaceId });
  if (!pipeline) throw new NotFoundError("Pipeline");
  await Pipeline.updateMany({ workspaceId: ctx.workspaceId }, { isDefault: false });
  pipeline.isDefault = true;
  await pipeline.save();
  await audit(ctx, "pipeline.set_default", "pipeline", pipeline._id, { entityName: pipeline.name });
  ok(res, pipeline);
});

pipelineRouter.delete("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "pipeline:configure");
  const pipeline = await Pipeline.findOne({ _id: paramId(req.params.id), workspaceId: ctx.workspaceId });
  if (!pipeline) throw new NotFoundError("Pipeline");
  if ((await Pipeline.countDocuments({ workspaceId: ctx.workspaceId })) <= 1) {
    throw new ConflictError("LAST_PIPELINE", "A workspace must keep at least one pipeline");
  }
  const deals = await Deal.countDocuments({ workspaceId: ctx.workspaceId, pipelineId: pipeline._id });
  if (deals) throw new ConflictError("PIPELINE_IN_USE", `This pipeline has ${deals} deal(s) and cannot be deleted`);
  await pipeline.deleteOne();
  if (pipeline.isDefault) {
    await Pipeline.findOneAndUpdate({ workspaceId: ctx.workspaceId }, { isDefault: true }, { sort: { createdAt: 1 } });
  }
  await audit(ctx, "pipeline.deleted", "pipeline", pipeline._id, { entityName: pipeline.name });
  ok(res, { deleted: true });
});
