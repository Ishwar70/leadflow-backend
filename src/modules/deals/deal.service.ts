import { Types } from "mongoose";
import { audit, logActivity, notify } from "../../lib/audit";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { requirePermission, scopeFilter, type WorkspaceContext } from "../../lib/permissions";
import { Deal, DealStageHistory, Pipeline } from "../../models/Deal";
import type { EntityType } from "../../models/Task";

export async function getDealOrThrow(ctx: WorkspaceContext, id: string) {
  const deal = await Deal.findOne({ _id: id, ...scopeFilter(ctx) });
  if (!deal) throw new NotFoundError("Deal");
  return deal;
}

export function dealLinks(deal: { _id: Types.ObjectId; companyId?: Types.ObjectId | null; contactId?: Types.ObjectId | null }) {
  const links: Array<{ entityType: EntityType; entityId: Types.ObjectId }> = [{ entityType: "deal", entityId: deal._id }];
  if (deal.companyId) links.push({ entityType: "company", entityId: deal.companyId });
  if (deal.contactId) links.push({ entityType: "contact", entityId: deal.contactId });
  return links;
}

export interface StageMoveInput {
  stageId: string;
  finalAmount?: number;
  closedAt?: Date | null;
  lostReason?: string;
}

/**
 * Moves a deal to another stage. Won stages require a final amount and close date;
 * lost stages require a reason. Every move writes stage history and a system activity.
 */
export async function moveDealStage(ctx: WorkspaceContext, id: string, input: StageMoveInput) {
  requirePermission(ctx, "records:update");
  const deal = await getDealOrThrow(ctx, id);
  const pipeline = await Pipeline.findOne({ _id: deal.pipelineId, workspaceId: ctx.workspaceId }).lean();
  if (!pipeline) throw new NotFoundError("Pipeline");
  const target = pipeline.stages.find((s) => String(s._id) === input.stageId);
  if (!target) throw new ValidationError("Stage does not belong to this deal's pipeline", { stageId: "Invalid stage" });
  const from = pipeline.stages.find((s) => String(s._id) === String(deal.stageId));

  if (String(deal.stageId) === input.stageId && deal.status === (target.type === "open" ? "open" : target.type)) {
    return deal;
  }

  if (target.type === "won") {
    const amount = input.finalAmount ?? null;
    if (amount === null || amount < 0) throw new ValidationError("Won deals require a final amount", { finalAmount: "Required" });
    if (!input.closedAt) throw new ValidationError("Won deals require a close date", { closedAt: "Required" });
    deal.status = "won";
    deal.finalAmount = amount;
    deal.closedAt = input.closedAt;
    deal.lostReason = null;
  } else if (target.type === "lost") {
    if (!input.lostReason?.trim()) throw new ValidationError("Lost deals require a reason", { lostReason: "Required" });
    deal.status = "lost";
    deal.lostReason = input.lostReason.trim();
    deal.closedAt = input.closedAt ?? new Date();
    deal.finalAmount = null;
  } else {
    deal.status = "open";
    deal.closedAt = null;
    deal.finalAmount = null;
    deal.lostReason = null;
  }
  deal.stageId = target._id as Types.ObjectId;
  deal.probability = target.probability ?? deal.probability;
  deal.stageChangedAt = new Date();
  await deal.save();

  await DealStageHistory.create({
    workspaceId: ctx.workspaceId,
    dealId: deal._id,
    fromStageId: from?._id ?? null,
    toStageId: target._id,
    fromStageName: from?.name ?? null,
    toStageName: target.name,
    changedBy: ctx.userId,
  });

  const type = target.type === "won" ? "deal_won" : target.type === "lost" ? "deal_lost" : "deal_stage";
  const summary =
    target.type === "won"
      ? `Deal marked Won (${deal.currency} ${deal.finalAmount?.toLocaleString("en-IN")})`
      : target.type === "lost"
        ? `Deal marked Lost: ${deal.lostReason}`
        : `Deal moved from ${from?.name ?? "-"} to ${target.name}`;
  await logActivity(ctx, { type, links: dealLinks(deal), summary, metadata: { from: from?.name, to: target.name } });

  if (target.type !== "open") {
    await audit(ctx, `deal.${target.type}`, "deal", deal._id, {
      entityName: deal.title,
      before: { stage: from?.name },
      after: { stage: target.name, finalAmount: deal.finalAmount, lostReason: deal.lostReason },
    });
  }
  if (String(deal.ownerId) !== String(ctx.userId)) {
    await notify({
      workspaceId: ctx.workspaceId,
      userId: deal.ownerId,
      type: "deal_stage",
      title: `${deal.title} moved to ${target.name}`,
      link: `/deals/${deal._id}`,
    });
  }
  return deal;
}

export async function stageOfType(ctx: WorkspaceContext, dealId: string, type: "won" | "lost") {
  const deal = await getDealOrThrow(ctx, dealId);
  const pipeline = await Pipeline.findOne({ _id: deal.pipelineId, workspaceId: ctx.workspaceId }).lean();
  const stage = pipeline?.stages.find((s) => s.type === type);
  if (!stage) throw new ValidationError(`Pipeline has no ${type} stage`);
  return String(stage._id);
}
