import mongoose, { Types } from "mongoose";
import type { z } from "zod";
import { audit, logActivity, notify } from "../../lib/audit";
import { readCsv } from "../../lib/csv";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import { escapeRegex } from "../../lib/http";
import { buildSearchText, normalizeEmail, normalizePhone } from "../../lib/normalize";
import { can, requirePermission, resolveOwner, scopeFilter, type WorkspaceContext } from "../../lib/permissions";
import { Company, Contact } from "../../models/Contact";
import { Deal, DealStageHistory, Pipeline } from "../../models/Deal";
import { Lead, LEAD_SOURCES, LEAD_STATUSES } from "../../models/Lead";
import { Workspace, Membership } from "../../models/Workspace";
import type { ConvertSchema, ImportSchema, LeadInputSchema, LeadListQuery } from "./lead.schemas";

type LeadInput = z.infer<typeof LeadInputSchema>;

export const leadName = (l: { firstName: string; lastName?: string | null }) => `${l.firstName} ${l.lastName ?? ""}`.trim();

export async function assertActiveMember(workspaceId: Types.ObjectId, userId: Types.ObjectId) {
  const m = await Membership.exists({ workspaceId, userId, status: "active" });
  if (!m) throw new ValidationError("Owner must be an active workspace member", { ownerId: "Not an active member" });
}

export function buildLeadFilter(ctx: WorkspaceContext, q: z.infer<typeof LeadListQuery>) {
  const filter: Record<string, unknown> = scopeFilter(ctx);
  filter.archivedAt = q.archived === "true" ? { $ne: null } : null;
  if (q.status) filter.status = q.status;
  if (q.source) filter.source = q.source;
  if (q.ownerId && can(ctx.role, "records:read_all")) filter.ownerId = new Types.ObjectId(q.ownerId);
  if (q.q) filter.searchText = { $regex: escapeRegex(q.q.toLowerCase()) };
  if (q.from || q.to) {
    filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }
  return filter;
}

export async function findDuplicates(workspaceId: Types.ObjectId, email: string | null, phone: string | null, excludeId?: Types.ObjectId) {
  const or: Record<string, unknown>[] = [];
  if (email) or.push({ normalizedEmail: email });
  if (phone) or.push({ normalizedPhone: phone });
  if (!or.length) return [];
  return Lead.find({ workspaceId, $or: or, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
    .select("firstName lastName email phone status archivedAt")
    .limit(5)
    .lean();
}

function derived(input: Partial<LeadInput>, existing?: Record<string, unknown>) {
  const merged = { ...(existing ?? {}), ...input } as Record<string, string | null | undefined>;
  return {
    normalizedEmail: normalizeEmail(merged.email),
    normalizedPhone: normalizePhone(merged.phone),
    searchText: buildSearchText(merged.firstName, merged.lastName, merged.email, merged.phone, merged.companyName),
  };
}

export async function createLead(ctx: WorkspaceContext, input: LeadInput, opts: { viaPublicApi?: boolean } = {}) {
  if (!opts.viaPublicApi) requirePermission(ctx, "records:create");
  const ownerId = resolveOwner(ctx, input.ownerId);
  await assertActiveMember(ctx.workspaceId, ownerId);
  const { allowDuplicate, ...data } = input;
  const d = derived(data);

  if (!allowDuplicate) {
    const dups = await findDuplicates(ctx.workspaceId, d.normalizedEmail, d.normalizedPhone);
    if (dups.length) {
      const err = new ConflictError("DUPLICATE_LEAD", "A lead with this email or phone already exists", {
        ...(dups.some((x) => x.email && normalizeEmail(x.email) === d.normalizedEmail) ? { email: "Duplicate email" } : {}),
        ...(dups.some((x) => x.phone && normalizePhone(x.phone) === d.normalizedPhone) ? { phone: "Duplicate phone" } : {}),
      });
      err.details = { duplicates: dups };
      throw err;
    }
  }

  const workspace = await Workspace.findById(ctx.workspaceId).select("currency").lean();
  const lead = await Lead.create({
    ...data,
    ...d,
    ownerId,
    currency: workspace?.currency ?? "INR",
    workspaceId: ctx.workspaceId,
    createdBy: ctx.userId,
  });
  await logActivity(ctx, {
    type: "created",
    links: [{ entityType: "lead", entityId: lead._id }],
    summary: opts.viaPublicApi ? `Lead captured from ${lead.source} form` : "Lead created",
  });
  await audit(ctx, "lead.created", "lead", lead._id, { entityName: leadName(lead) });
  if (String(ownerId) !== String(ctx.userId)) {
    await notify({
      workspaceId: ctx.workspaceId,
      userId: ownerId,
      type: "lead_assigned",
      title: `New lead assigned: ${leadName(lead)}`,
      body: lead.companyName || "",
      link: `/leads/${lead._id}`,
    });
  }
  return lead;
}

export async function getLeadOrThrow(ctx: WorkspaceContext, id: string) {
  const lead = await Lead.findOne({ _id: id, ...scopeFilter(ctx) });
  if (!lead) throw new NotFoundError("Lead");
  return lead;
}

export async function updateLead(ctx: WorkspaceContext, id: string, input: Partial<LeadInput>) {
  requirePermission(ctx, "records:update");
  const lead = await getLeadOrThrow(ctx, id);
  if (lead.status === "converted" && input.status) throw new ValidationError("Converted leads cannot change status");

  const before = { status: lead.status, ownerId: String(lead.ownerId), estimatedValue: lead.estimatedValue };
  const changes: Record<string, unknown> = { ...input };

  if (input.ownerId !== undefined) {
    const newOwner = input.ownerId ? new Types.ObjectId(input.ownerId) : lead.ownerId;
    if (String(newOwner) !== String(lead.ownerId)) {
      requirePermission(ctx, "records:assign");
      await assertActiveMember(ctx.workspaceId, newOwner);
    }
    changes.ownerId = newOwner;
  }

  const d = derived(input, lead.toObject());
  if (d.normalizedEmail !== lead.normalizedEmail || d.normalizedPhone !== lead.normalizedPhone) {
    const dups = await findDuplicates(
      ctx.workspaceId,
      d.normalizedEmail !== lead.normalizedEmail ? d.normalizedEmail : null,
      d.normalizedPhone !== lead.normalizedPhone ? d.normalizedPhone : null,
      lead._id,
    );
    if (dups.length) throw new ConflictError("DUPLICATE_LEAD", "Another lead already uses this email or phone");
  }
  Object.assign(lead, changes, d);
  await lead.save();

  if (input.status && input.status !== before.status) {
    await logActivity(ctx, {
      type: "status_change",
      links: [{ entityType: "lead", entityId: lead._id }],
      summary: `Status changed from ${before.status} to ${input.status}`,
      metadata: { from: before.status, to: input.status },
    });
  }
  if (String(lead.ownerId) !== before.ownerId) {
    await logActivity(ctx, {
      type: "assigned",
      links: [{ entityType: "lead", entityId: lead._id }],
      summary: "Lead reassigned",
      metadata: { from: before.ownerId, to: String(lead.ownerId) },
    });
    await audit(ctx, "lead.assigned", "lead", lead._id, {
      entityName: leadName(lead),
      before: { ownerId: before.ownerId },
      after: { ownerId: String(lead.ownerId) },
    });
    if (String(lead.ownerId) !== String(ctx.userId)) {
      await notify({
        workspaceId: ctx.workspaceId,
        userId: lead.ownerId,
        type: "lead_assigned",
        title: `Lead assigned to you: ${leadName(lead)}`,
        link: `/leads/${lead._id}`,
      });
    }
  }
  return lead;
}

export async function setArchived(ctx: WorkspaceContext, id: string, archived: boolean) {
  requirePermission(ctx, "records:archive");
  const lead = await getLeadOrThrow(ctx, id);
  lead.archivedAt = archived ? new Date() : null;
  await lead.save();
  await audit(ctx, archived ? "lead.archived" : "lead.restored", "lead", lead._id, { entityName: leadName(lead) });
  return lead;
}

export async function bulkUpdate(
  ctx: WorkspaceContext,
  input:
    | { action: "assign"; ids: string[]; ownerId: string }
    | { action: "status"; ids: string[]; status: string }
    | { action: "archive" | "restore"; ids: string[] },
) {
  const filter = { ...scopeFilter(ctx), _id: { $in: input.ids.map((i) => new Types.ObjectId(i)) } };
  let update: Record<string, unknown>;
  switch (input.action) {
    case "assign": {
      requirePermission(ctx, "records:assign");
      const ownerId = new Types.ObjectId(input.ownerId);
      await assertActiveMember(ctx.workspaceId, ownerId);
      update = { ownerId };
      break;
    }
    case "status":
      requirePermission(ctx, "records:update");
      update = { status: input.status };
      Object.assign(filter, { status: { $ne: "converted" } });
      break;
    case "archive":
      requirePermission(ctx, "records:archive");
      update = { archivedAt: new Date() };
      break;
    case "restore":
      requirePermission(ctx, "records:archive");
      update = { archivedAt: null };
      break;
  }
  const result = await Lead.updateMany(filter, update);
  await audit(ctx, `lead.bulk_${input.action}`, "lead", null, {
    after: { count: result.modifiedCount, ...update, ids: input.ids.slice(0, 50) },
  });
  return { updated: result.modifiedCount };
}

/** Converts a lead into contact (+ optional company and deal) atomically. */
export async function convertLead(ctx: WorkspaceContext, id: string, input: z.infer<typeof ConvertSchema>) {
  requirePermission(ctx, "records:update");
  const session = await mongoose.startSession();
  try {
    let result: { contactId: string; companyId: string | null; dealId: string | null } | null = null;
    await session.withTransaction(async () => {
      const lead = await Lead.findOne({ _id: id, ...scopeFilter(ctx), archivedAt: null }).session(session);
      if (!lead) throw new NotFoundError("Lead");
      if (lead.status === "converted") throw new ConflictError("ALREADY_CONVERTED", "This lead has already been converted");

      let companyId: Types.ObjectId | null = null;
      const companyName = (input.companyName || lead.companyName || "").trim();
      if (input.createCompany && companyName) {
        const existing = await Company.findOne({
          workspaceId: ctx.workspaceId,
          name: { $regex: `^${escapeRegex(companyName)}$`, $options: "i" },
          archivedAt: null,
        }).session(session);
        if (existing) companyId = existing._id;
        else {
          const [company] = await Company.create(
            [
              {
                workspaceId: ctx.workspaceId,
                name: companyName,
                city: lead.city,
                country: lead.country,
                ownerId: lead.ownerId,
                createdBy: ctx.userId,
                searchText: buildSearchText(companyName),
              },
            ],
            { session },
          );
          companyId = company._id;
        }
      }

      const [contact] = await Contact.create(
        [
          {
            workspaceId: ctx.workspaceId,
            firstName: lead.firstName,
            lastName: lead.lastName,
            email: lead.email,
            normalizedEmail: lead.normalizedEmail,
            phone: lead.phone,
            normalizedPhone: lead.normalizedPhone,
            jobTitle: lead.jobTitle,
            companyId,
            ownerId: lead.ownerId,
            leadId: lead._id,
            tags: lead.tags,
            city: lead.city,
            country: lead.country,
            createdBy: ctx.userId,
            searchText: buildSearchText(lead.firstName, lead.lastName, lead.email, lead.phone, companyName),
          },
        ],
        { session },
      );

      let dealId: Types.ObjectId | null = null;
      if (input.createDeal) {
        const pipeline = input.pipelineId
          ? await Pipeline.findOne({ _id: input.pipelineId, workspaceId: ctx.workspaceId }).session(session)
          : await Pipeline.findOne({ workspaceId: ctx.workspaceId }).sort({ isDefault: -1, createdAt: 1 }).session(session);
        if (!pipeline) throw new ValidationError("No pipeline exists. Create a pipeline first.");
        const firstStage = [...pipeline.stages].filter((s) => s.type === "open").sort((a, b) => a.order - b.order)[0];
        if (!firstStage) throw new ValidationError("Pipeline has no open stages");
        const title = input.dealTitle || `${companyName || leadName(lead)} - Opportunity`;
        const [deal] = await Deal.create(
          [
            {
              workspaceId: ctx.workspaceId,
              title,
              pipelineId: pipeline._id,
              stageId: firstStage._id,
              ownerId: lead.ownerId,
              companyId,
              contactId: contact._id,
              leadId: lead._id,
              value: input.dealValue ?? lead.estimatedValue ?? 0,
              currency: lead.currency,
              probability: firstStage.probability,
              expectedCloseDate: input.expectedCloseDate,
              createdBy: ctx.userId,
              searchText: buildSearchText(title, companyName),
            },
          ],
          { session },
        );
        dealId = deal._id;
        await DealStageHistory.create(
          [
            {
              workspaceId: ctx.workspaceId,
              dealId: deal._id,
              toStageId: firstStage._id,
              toStageName: firstStage.name,
              changedBy: ctx.userId,
            },
          ],
          { session },
        );
      }

      lead.status = "converted";
      lead.convertedAt = new Date();
      lead.convertedContactId = contact._id;
      lead.convertedCompanyId = companyId;
      lead.convertedDealId = dealId;
      await lead.save({ session });

      const links: Array<{ entityType: "lead" | "contact" | "company" | "deal"; entityId: Types.ObjectId }> = [
        { entityType: "lead", entityId: lead._id },
        { entityType: "contact", entityId: contact._id },
      ];
      if (companyId) links.push({ entityType: "company", entityId: companyId });
      if (dealId) links.push({ entityType: "deal", entityId: dealId });

      // Carry historic lead activities onto the new records so the timeline stays unified.
      await mongoose.model("Activity").updateMany(
        { workspaceId: ctx.workspaceId, "links.entityType": "lead", "links.entityId": lead._id },
        { $addToSet: { links: { $each: links.slice(1) } } },
        { session },
      );
      await mongoose.model("Activity").create(
        [
          {
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId,
            type: "converted",
            links,
            summary: `Lead converted to contact${companyId ? ", company" : ""}${dealId ? " and deal" : ""}`,
            isSystem: true,
          },
        ],
        { session },
      );
      result = { contactId: String(contact._id), companyId: companyId ? String(companyId) : null, dealId: dealId ? String(dealId) : null };
    });
    await audit(ctx, "lead.converted", "lead", new Types.ObjectId(id), { after: result });
    return result!;
  } finally {
    await session.endSession();
  }
}

// ---------- Import ----------

export function suggestMapping(headers: string[]) {
  const aliases: Record<string, string[]> = {
    firstName: ["first name", "firstname", "first", "name", "full name"],
    lastName: ["last name", "lastname", "surname", "last"],
    email: ["email", "e-mail", "email address", "mail"],
    phone: ["phone", "mobile", "phone number", "contact number", "whatsapp"],
    companyName: ["company", "company name", "organization", "organisation", "business"],
    jobTitle: ["title", "job title", "designation", "position", "role"],
    source: ["source", "lead source", "channel"],
    status: ["status", "lead status", "stage"],
    estimatedValue: ["value", "estimated value", "deal value", "amount", "budget"],
    city: ["city", "town"],
    country: ["country"],
    tags: ["tags", "labels"],
  };
  const mapping: Record<string, string> = {};
  for (const h of headers) {
    const key = h.toLowerCase().replace(/[_-]+/g, " ").trim();
    mapping[h] = Object.entries(aliases).find(([, list]) => list.includes(key))?.[0] ?? "";
  }
  return mapping;
}

export async function importLeads(ctx: WorkspaceContext, input: z.infer<typeof ImportSchema>) {
  requirePermission(ctx, "records:create");
  const { rows } = readCsv(input.csv);
  const fieldToHeader = Object.fromEntries(
    Object.entries(input.mapping)
      .filter(([, f]) => f)
      .map(([h, f]) => [f, h]),
  );
  if (!fieldToHeader.firstName) throw new ValidationError("Map a column to First name before importing");

  const workspace = await Workspace.findById(ctx.workspaceId).select("currency").lean();
  const errors: Array<{ row: number; message: string; data: Record<string, string> }> = [];
  const skipped: Array<{ row: number; message: string; data: Record<string, string> }> = [];
  const docs: Record<string, unknown>[] = [];

  const existing = await Lead.find({ workspaceId: ctx.workspaceId })
    .select("normalizedEmail normalizedPhone")
    .lean();
  const seenEmails = new Set(existing.map((l) => l.normalizedEmail).filter(Boolean) as string[]);
  const seenPhones = new Set(existing.map((l) => l.normalizedPhone).filter(Boolean) as string[]);

  rows.forEach((raw, index) => {
    const rowNumber = index + 2;
    const get = (f: string) => (fieldToHeader[f] ? (raw[fieldToHeader[f]] ?? "").trim() : "");
    let firstName = get("firstName");
    let lastName = get("lastName");
    if (firstName && !fieldToHeader.lastName && firstName.includes(" ")) {
      const parts = firstName.split(/\s+/);
      firstName = parts.shift()!;
      lastName = parts.join(" ");
    }
    const problems: string[] = [];
    if (!firstName) problems.push("First name is required");
    const email = get("email");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push(`Invalid email "${email}"`);
    const phone = get("phone");
    if (phone && phone.replace(/\D/g, "").length < 7) problems.push(`Invalid phone "${phone}"`);
    const sourceRaw = get("source").toLowerCase();
    const source = (LEAD_SOURCES as readonly string[]).includes(sourceRaw) ? sourceRaw : sourceRaw ? null : "other";
    if (source === null) problems.push(`Unknown source "${sourceRaw}"`);
    const statusRaw = get("status").toLowerCase();
    const status = (LEAD_STATUSES as readonly string[]).includes(statusRaw) && statusRaw !== "converted" ? statusRaw : statusRaw ? null : "new";
    if (status === null) problems.push(`Unknown status "${statusRaw}"`);
    const valueRaw = get("estimatedValue").replace(/[,\s₹$]/g, "");
    const estimatedValue = valueRaw ? Number(valueRaw) : 0;
    if (Number.isNaN(estimatedValue) || estimatedValue < 0) problems.push(`Invalid value "${get("estimatedValue")}"`);

    if (problems.length) {
      errors.push({ row: rowNumber, message: problems.join("; "), data: raw });
      return;
    }
    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);
    const duplicate = (normalizedEmail && seenEmails.has(normalizedEmail)) || (normalizedPhone && seenPhones.has(normalizedPhone));
    if (duplicate && input.duplicateStrategy === "skip") {
      skipped.push({ row: rowNumber, message: "Duplicate email or phone", data: raw });
      return;
    }
    if (normalizedEmail) seenEmails.add(normalizedEmail);
    if (normalizedPhone) seenPhones.add(normalizedPhone);
    const companyName = get("companyName");
    docs.push({
      workspaceId: ctx.workspaceId,
      firstName,
      lastName,
      email: email || null,
      normalizedEmail,
      phone: phone || null,
      normalizedPhone,
      companyName,
      jobTitle: get("jobTitle"),
      source,
      status,
      estimatedValue,
      currency: workspace?.currency ?? "INR",
      city: get("city"),
      country: get("country"),
      tags: get("tags")
        .split(/[;,|]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20),
      ownerId: ctx.userId,
      createdBy: ctx.userId,
      searchText: buildSearchText(firstName, lastName, email, phone, companyName),
    });
  });

  let createdCount = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const inserted = await Lead.insertMany(docs.slice(i, i + 500), { ordered: false });
    createdCount += inserted.length;
  }
  await audit(ctx, "lead.imported", "lead", null, {
    after: { total: rows.length, created: createdCount, skipped: skipped.length, failed: errors.length },
  });
  await notify({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    type: "import_completed",
    title: `Import finished: ${createdCount} leads created`,
    body: `${skipped.length} duplicates skipped, ${errors.length} rows failed`,
    link: "/leads",
  });
  return { total: rows.length, created: createdCount, skipped, errors };
}

export function ensureCanSeeOwnerFilter(ctx: WorkspaceContext, ownerId?: string) {
  if (ownerId && !can(ctx.role, "records:read_all") && ownerId !== String(ctx.userId)) throw new ForbiddenError();
}
