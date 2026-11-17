import { Router } from "express";
import rateLimit from "express-rate-limit";
import { Types } from "mongoose";
import { z } from "zod";
import { env } from "../../config/env";
import { emailLayout, sendEmail } from "../../lib/email";
import { UnauthorizedError } from "../../lib/errors";
import { created, ok, parse } from "../../lib/http";
import { sha256 } from "../../lib/tokens";
import { Lead, LEAD_SOURCES } from "../../models/Lead";
import { ApiKey, Notification } from "../../models/System";
import { Task } from "../../models/Task";
import { Membership, Workspace } from "../../models/Workspace";
import { createLead } from "../leads/lead.service";

export const publicRouter = Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env().NODE_ENV === "test",
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many requests" } },
});

const PublicLeadSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(80),
  lastName: z.string().trim().max(80).optional().default(""),
  email: z.union([z.string().trim().email("Enter a valid email"), z.literal("")]).optional().transform((v) => v || null),
  phone: z.string().trim().max(30).optional().transform((v) => v || null),
  companyName: z.string().trim().max(160).optional().default(""),
  jobTitle: z.string().trim().max(120).optional().default(""),
  message: z.string().trim().max(2000).optional().default(""),
  source: z.enum(LEAD_SOURCES).optional().default("website"),
  estimatedValue: z.coerce.number().min(0).max(1e12).optional().default(0),
});

/** Picks the next active sales rep (falling back to managers, then the owner) in round-robin order. */
async function nextAssignee(workspaceId: Types.ObjectId) {
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) throw new UnauthorizedError("Invalid API key");
  for (const role of ["sales_rep", "manager"] as const) {
    const members = await Membership.find({ workspaceId, role, status: "active" }).sort({ createdAt: 1 }).lean();
    if (members.length && workspace.settings?.autoAssignPublicLeads !== false) {
      const cursor = workspace.settings?.roundRobinCursor ?? 0;
      const pick = members[cursor % members.length];
      await Workspace.updateOne({ _id: workspaceId }, { $inc: { "settings.roundRobinCursor": 1 } });
      return pick.userId as Types.ObjectId;
    }
  }
  return workspace.ownerId as Types.ObjectId;
}

publicRouter.post("/leads", publicLimiter, async (req, res) => {
  const header = req.headers["x-api-key"];
  const secret = typeof header === "string" ? header : null;
  if (!secret) throw new UnauthorizedError("Missing x-api-key header");
  const key = await ApiKey.findOne({ keyHash: sha256(secret), revokedAt: null });
  if (!key) throw new UnauthorizedError("Invalid API key");
  key.lastUsedAt = new Date();
  await key.save();
  const workspaceId = key.workspaceId as Types.ObjectId;

  const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 100) : undefined;
  if (idempotencyKey) {
    const existing = await Lead.findOne({ workspaceId, idempotencyKey }).select("_id").lean();
    if (existing) return ok(res, { id: String(existing._id), duplicate: true });
  }

  const input = parse(PublicLeadSchema, req.body);
  const ownerId = await nextAssignee(workspaceId);
  const ctx = { workspaceId, userId: ownerId, role: "owner" as const };
  const { message, ...leadFields } = input;
  const lead = await createLead(
    ctx,
    { ...leadFields, status: "new", ownerId: String(ownerId), tags: ["web-form"], city: "", country: "", nextFollowUpAt: null, allowDuplicate: true },
    { viaPublicApi: true },
  );
  if (idempotencyKey) await Lead.updateOne({ _id: lead._id }, { idempotencyKey });

  const dueAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  await Task.create({
    workspaceId,
    title: `Call new ${input.source} lead: ${input.firstName} ${input.lastName}`.trim(),
    description: message,
    type: "call",
    priority: input.estimatedValue >= 50000 ? "high" : "medium",
    dueAt,
    assignedTo: ownerId,
    relatedType: "lead",
    relatedId: lead._id,
    relatedName: `${input.firstName} ${input.lastName}`.trim(),
    createdBy: ownerId,
  });
  await Lead.updateOne({ _id: lead._id }, { nextFollowUpAt: dueAt });
  await Notification.create({
    workspaceId,
    userId: ownerId,
    type: "lead_assigned",
    title: `New website lead: ${input.firstName} ${input.lastName}`.trim(),
    body: input.companyName,
    link: `/leads/${lead._id}`,
  });
  if (input.email) {
    const workspace = await Workspace.findById(workspaceId).select("name").lean();
    await sendEmail(
      input.email,
      `Thanks for contacting ${workspace?.name}`,
      emailLayout(`Hi ${input.firstName},`, `Thanks for reaching out to ${workspace?.name}. A member of our team will contact you shortly.`),
    );
  }
  created(res, { id: String(lead._id) });
});
