import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { escapeRegex, objectId, ok, parse } from "../../lib/http";
import { averageDealValue, conversionRate, winRate } from "../../lib/metrics";
import { can, requirePermission, scopeFilter } from "../../lib/permissions";
import { ctxOf } from "../../middleware/auth";
import { Activity } from "../../models/Activity";
import { Company, Contact } from "../../models/Contact";
import { Deal, Pipeline } from "../../models/Deal";
import { Lead, LEAD_SOURCES } from "../../models/Lead";
import { Task } from "../../models/Task";
import { User } from "../../models/User";

export const reportRouter = Router();
export const searchRouter = Router();

const OverviewQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ownerId: objectId.optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  pipelineId: objectId.optional(),
});

reportRouter.get("/overview", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "reports:view");
  const q = parse(OverviewQuery, req.query);
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const period = { $gte: from, $lte: to };

  const leadBase: Record<string, unknown> = { ...scopeFilter(ctx), archivedAt: null };
  const dealBase: Record<string, unknown> = { ...scopeFilter(ctx), archivedAt: null };
  if (q.ownerId && can(ctx.role, "records:read_all")) {
    leadBase.ownerId = new Types.ObjectId(q.ownerId);
    dealBase.ownerId = new Types.ObjectId(q.ownerId);
  }
  if (q.source) leadBase.source = q.source;

  const pipeline = q.pipelineId
    ? await Pipeline.findOne({ _id: q.pipelineId, workspaceId: ctx.workspaceId }).lean()
    : await Pipeline.findOne({ workspaceId: ctx.workspaceId }).sort({ isDefault: -1, createdAt: 1 }).lean();
  if (q.pipelineId && pipeline) dealBase.pipelineId = pipeline._id;

  const sixMonthsAgo = new Date(to.getFullYear(), to.getMonth() - 5, 1);

  const [
    totalLeads,
    newLeads,
    qualifiedLeads,
    periodConverted,
    openAgg,
    closedAgg,
    leadsBySource,
    stageAgg,
    revenueByMonth,
    overdueTasks,
    recentActivity,
    topOwners,
  ] = await Promise.all([
    Lead.countDocuments(leadBase),
    Lead.countDocuments({ ...leadBase, createdAt: period }),
    Lead.countDocuments({ ...leadBase, status: "qualified" }),
    Lead.countDocuments({ ...leadBase, createdAt: period, status: "converted" }),
    Deal.aggregate([
      { $match: { ...dealBase, status: "open" } },
      {
        $group: {
          _id: null,
          value: { $sum: "$value" },
          weighted: { $sum: { $divide: [{ $multiply: ["$value", "$probability"] }, 100] } },
          count: { $sum: 1 },
        },
      },
    ]),
    Deal.aggregate([
      { $match: { ...dealBase, status: { $in: ["won", "lost"] }, closedAt: period } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$finalAmount", "$value"] } },
        },
      },
    ]),
    Lead.aggregate([
      { $match: { ...leadBase, createdAt: period } },
      { $group: { _id: "$source", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    pipeline
      ? Deal.aggregate([
          { $match: { ...dealBase, pipelineId: pipeline._id, status: "open" } },
          { $group: { _id: "$stageId", count: { $sum: 1 }, value: { $sum: "$value" } } },
        ])
      : Promise.resolve([]),
    Deal.aggregate([
      { $match: { ...dealBase, status: "won", closedAt: { $gte: sixMonthsAgo, $lte: to } } },
      {
        $group: {
          _id: { y: { $year: "$closedAt" }, m: { $month: "$closedAt" } },
          revenue: { $sum: { $ifNull: ["$finalAmount", "$value"] } },
          count: { $sum: 1 },
        },
      },
    ]),
    Task.countDocuments({ ...scopeFilter(ctx, "assignedTo"), status: "open", dueAt: { $lt: new Date() } }),
    Activity.find({
      workspaceId: ctx.workspaceId,
      ...(can(ctx.role, "records:read_all") ? {} : { actorId: ctx.userId }),
    })
      .sort({ occurredAt: -1 })
      .limit(8)
      .populate("actorId", "name")
      .lean(),
    can(ctx.role, "records:read_all")
      ? Deal.aggregate([
          { $match: { ...dealBase, status: "won", closedAt: period } },
          { $group: { _id: "$ownerId", revenue: { $sum: { $ifNull: ["$finalAmount", "$value"] } }, count: { $sum: 1 } } },
          { $sort: { revenue: -1 } },
          { $limit: 5 },
        ])
      : Promise.resolve([]),
  ]);

  const won = closedAgg.find((x) => x._id === "won") ?? { count: 0, revenue: 0 };
  const lost = closedAgg.find((x) => x._id === "lost") ?? { count: 0 };
  const owners = await User.find({ _id: { $in: topOwners.map((o) => o._id) } }).select("name").lean();

  const months: Array<{ month: string; revenue: number; deals: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(to.getFullYear(), to.getMonth() - i, 1);
    const hit = revenueByMonth.find((r) => r._id.y === d.getFullYear() && r._id.m === d.getMonth() + 1);
    months.push({
      month: d.toLocaleString("en-US", { month: "short", year: "2-digit" }),
      revenue: hit?.revenue ?? 0,
      deals: hit?.count ?? 0,
    });
  }

  ok(res, {
    range: { from, to },
    kpis: {
      totalLeads,
      newLeads,
      qualifiedLeads,
      conversionRate: conversionRate(periodConverted, newLeads),
      openPipelineValue: Math.round(openAgg[0]?.value ?? 0),
      openDeals: openAgg[0]?.count ?? 0,
      weightedForecast: Math.round(openAgg[0]?.weighted ?? 0),
      wonRevenue: Math.round(won.revenue),
      wonDeals: won.count,
      lostDeals: lost.count,
      winRate: winRate(won.count, lost.count),
      averageDealValue: averageDealValue(won.revenue, won.count),
      overdueTasks,
    },
    leadsBySource: leadsBySource.map((s) => ({ source: s._id, count: s.count })),
    dealsByStage: pipeline
      ? [...pipeline.stages]
          .filter((s) => s.type === "open")
          .sort((a, b) => a.order - b.order)
          .map((s) => {
            const hit = stageAgg.find((x) => String(x._id) === String(s._id));
            return { stage: s.name, color: s.color, count: hit?.count ?? 0, value: hit?.value ?? 0 };
          })
      : [],
    revenueByMonth: months,
    topPerformers: topOwners.map((o) => ({
      userId: String(o._id),
      name: owners.find((u) => String(u._id) === String(o._id))?.name ?? "Unknown",
      revenue: o.revenue,
      deals: o.count,
    })),
    recentActivity,
    pipeline: pipeline ? { _id: pipeline._id, name: pipeline.name } : null,
  });
});

searchRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const { q } = parse(z.object({ q: z.string().trim().min(2, "Type at least 2 characters").max(100) }), req.query);
  const regex = { $regex: escapeRegex(q.toLowerCase()) };
  const base = { ...scopeFilter(ctx), archivedAt: null, searchText: regex };
  const [leads, contacts, companies, deals] = await Promise.all([
    Lead.find(base).select("firstName lastName email companyName status").limit(6).lean(),
    Contact.find(base).select("firstName lastName email jobTitle").limit(6).lean(),
    Company.find(base).select("name domain industry").limit(6).lean(),
    Deal.find(base).select("title value currency status").limit(6).lean(),
  ]);
  ok(res, { leads, contacts, companies, deals });
});
