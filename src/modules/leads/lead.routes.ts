import { Router } from "express";
import { z } from "zod";
import { readCsv, toCsv } from "../../lib/csv";
import { created, ok, onlyProvided, paramId, parse } from "../../lib/http";
import { requirePermission } from "../../lib/permissions";
import { ctxOf } from "../../middleware/auth";
import { Lead } from "../../models/Lead";
import { BulkSchema, ConvertSchema, ImportSchema, LeadInputSchema, LeadListQuery, LeadUpdateSchema } from "./lead.schemas";
import {
  buildLeadFilter,
  bulkUpdate,
  convertLead,
  createLead,
  ensureCanSeeOwnerFilter,
  findDuplicates,
  getLeadOrThrow,
  importLeads,
  setArchived,
  suggestMapping,
  updateLead,
} from "./lead.service";
import { normalizeEmail, normalizePhone } from "../../lib/normalize";

export const leadRouter = Router();

const OWNER_FIELDS = "name email";

leadRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(LeadListQuery, req.query);
  ensureCanSeeOwnerFilter(ctx, q.ownerId);
  const filter = buildLeadFilter(ctx, q);
  const sortField = q.sort.replace("-", "");
  const sort: Record<string, 1 | -1> = { [sortField]: q.sort.startsWith("-") ? -1 : 1, _id: -1 };
  const [items, total] = await Promise.all([
    Lead.find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("ownerId", OWNER_FIELDS)
      .lean(),
    Lead.countDocuments(filter),
  ]);
  ok(res, items, { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) });
});

leadRouter.post("/", async (req, res) => {
  const ctx = ctxOf(req);
  const input = parse(LeadInputSchema, req.body);
  const lead = await createLead(ctx, input);
  created(res, lead);
});

leadRouter.get("/export", async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(LeadListQuery.omit({ page: true, limit: true }), req.query);
  ensureCanSeeOwnerFilter(ctx, q.ownerId);
  const filter = buildLeadFilter(ctx, { ...q, page: 1, limit: 100 });
  const leads = await Lead.find(filter).sort({ createdAt: -1 }).limit(10000).populate("ownerId", OWNER_FIELDS).lean();
  const headers = [
    "firstName", "lastName", "email", "phone", "companyName", "jobTitle", "source", "status",
    "estimatedValue", "currency", "owner", "city", "country", "tags", "nextFollowUpAt", "createdAt",
  ];
  const rows = leads.map((l) => ({
    ...l,
    owner: (l.ownerId as unknown as { name?: string })?.name ?? "",
    tags: (l.tags ?? []).join("; "),
  }));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(headers, rows));
});

leadRouter.post("/import/preview", async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "records:create");
  const { csv } = parse(z.object({ csv: z.string().min(1).max(3_000_000) }), req.body);
  const { headers, rows } = readCsv(csv);
  ok(res, { headers, totalRows: rows.length, preview: rows.slice(0, 5), suggestedMapping: suggestMapping(headers) });
});

leadRouter.post("/import", async (req, res) => {
  const ctx = ctxOf(req);
  const input = parse(ImportSchema, req.body);
  ok(res, await importLeads(ctx, input));
});

leadRouter.post("/check-duplicates", async (req, res) => {
  const ctx = ctxOf(req);
  const { email, phone } = parse(z.object({ email: z.string().optional(), phone: z.string().optional() }), req.body);
  ok(res, await findDuplicates(ctx.workspaceId, normalizeEmail(email), normalizePhone(phone)));
});

leadRouter.post("/bulk", async (req, res) => {
  const ctx = ctxOf(req);
  ok(res, await bulkUpdate(ctx, parse(BulkSchema, req.body)));
});

leadRouter.get("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  const lead = await getLeadOrThrow(ctx, paramId(req.params.id));
  await lead.populate("ownerId", OWNER_FIELDS);
  ok(res, lead);
});

leadRouter.patch("/:id", async (req, res) => {
  const ctx = ctxOf(req);
  const input = onlyProvided(parse(LeadUpdateSchema, req.body), req.body);
  const lead = await updateLead(ctx, paramId(req.params.id), input);
  await lead.populate("ownerId", OWNER_FIELDS);
  ok(res, lead);
});

leadRouter.post("/:id/archive", async (req, res) => {
  ok(res, await setArchived(ctxOf(req), paramId(req.params.id), true));
});

leadRouter.post("/:id/restore", async (req, res) => {
  ok(res, await setArchived(ctxOf(req), paramId(req.params.id), false));
});

leadRouter.post("/:id/convert", async (req, res) => {
  const ctx = ctxOf(req);
  const input = parse(ConvertSchema, req.body ?? {});
  ok(res, await convertLead(ctx, paramId(req.params.id), input));
});
