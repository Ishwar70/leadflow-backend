import { Router } from "express";
import { z } from "zod";
import { appUrl } from "../../config/env";
import { audit, notify } from "../../lib/audit";
import { emailEnabled, emailLayout, sendEmail } from "../../lib/email";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import { created, objectId, ok, paramId, parse, toObjectId } from "../../lib/http";
import { requirePermission, ROLES } from "../../lib/permissions";
import { randomToken, sha256 } from "../../lib/tokens";
import { ctxOf, requireAuth, requireWorkspace } from "../../middleware/auth";
import { Contact, Company } from "../../models/Contact";
import { Deal } from "../../models/Deal";
import { Lead } from "../../models/Lead";
import { Task } from "../../models/Task";
import { User } from "../../models/User";
import { Invitation, Membership, Workspace } from "../../models/Workspace";
import { createWorkspace, getSession } from "./workspace.service";

export const workspaceRouter = Router();

const WorkspaceSchema = z.object({
  name: z.string().trim().min(2, "Workspace name is required").max(120),
  industry: z.string().trim().max(80).optional(),
  size: z.string().trim().max(20).optional(),
  timezone: z.string().trim().max(60).optional(),
  country: z.string().trim().max(60).optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
});

workspaceRouter.post("/workspaces", requireAuth, async (req, res) => {
  const input = parse(WorkspaceSchema, req.body);
  await createWorkspace(req.userId!, input);
  created(res, await getSession(req.userId!));
});

workspaceRouter.post("/workspaces/:id/switch", requireAuth, async (req, res) => {
  const workspaceId = toObjectId(paramId(req.params.id));
  const membership = await Membership.findOne({ userId: req.userId, workspaceId, status: "active" });
  if (!membership) throw new NotFoundError("Workspace");
  await User.updateOne({ _id: req.userId }, { activeWorkspaceId: workspaceId });
  ok(res, await getSession(req.userId!));
});

workspaceRouter.get("/workspaces/current", requireAuth, requireWorkspace, async (req, res) => {
  const ctx = ctxOf(req);
  const workspace = await Workspace.findById(ctx.workspaceId).lean();
  ok(res, { ...workspace, role: ctx.role });
});

workspaceRouter.patch("/workspaces/current", requireAuth, requireWorkspace, async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "workspace:manage");
  const input = parse(
    WorkspaceSchema.partial().extend({ autoAssignPublicLeads: z.boolean().optional() }),
    req.body,
  );
  const before = await Workspace.findById(ctx.workspaceId).lean();
  const { autoAssignPublicLeads, ...rest } = input;
  const update: Record<string, unknown> = { ...rest };
  if (autoAssignPublicLeads !== undefined) update["settings.autoAssignPublicLeads"] = autoAssignPublicLeads;
  const workspace = await Workspace.findByIdAndUpdate(ctx.workspaceId, update, { returnDocument: "after" }).lean();
  await audit(ctx, "workspace.updated", "workspace", ctx.workspaceId, {
    entityName: workspace?.name,
    before: { name: before?.name, currency: before?.currency, timezone: before?.timezone },
    after: rest,
  });
  ok(res, workspace);
});

// ---------- Members ----------

workspaceRouter.get("/members", requireAuth, requireWorkspace, async (req, res) => {
  const ctx = ctxOf(req);
  const memberships = await Membership.find({ workspaceId: ctx.workspaceId }).sort({ createdAt: 1 }).lean();
  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } }).select("name email").lean();
  ok(
    res,
    memberships.map((m) => {
      const u = users.find((x) => String(x._id) === String(m.userId));
      return {
        userId: String(m.userId),
        name: u?.name ?? "Unknown",
        email: u?.email ?? "",
        role: m.role,
        status: m.status,
        joinedAt: m.createdAt,
      };
    }),
  );
});

workspaceRouter.patch("/members/:userId", requireAuth, requireWorkspace, async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "members:manage");
  const userId = toObjectId(paramId(req.params.userId));
  const { role } = parse(z.object({ role: z.enum(ROLES).exclude(["owner"]) }), req.body);
  const membership = await Membership.findOne({ workspaceId: ctx.workspaceId, userId });
  if (!membership) throw new NotFoundError("Member");
  if (membership.role === "owner") throw new ForbiddenError("The workspace owner's role cannot be changed");
  if (String(userId) === String(ctx.userId)) throw new ForbiddenError("You cannot change your own role");
  if ((role === "admin" || membership.role === "admin") && ctx.role !== "owner") {
    throw new ForbiddenError("Only the owner can grant or change the admin role");
  }
  const before = membership.role;
  membership.role = role;
  await membership.save();
  await audit(ctx, "member.role_changed", "member", userId, { before: { role: before }, after: { role } });
  ok(res, { userId: String(userId), role });
});

workspaceRouter.post("/members/:userId/deactivate", requireAuth, requireWorkspace, async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "members:manage");
  const userId = toObjectId(paramId(req.params.userId));
  const { transferTo } = parse(z.object({ transferTo: objectId }), req.body);
  const transferId = toObjectId(transferTo);
  if (String(userId) === String(ctx.userId)) throw new ForbiddenError("You cannot deactivate yourself");
  if (String(userId) === String(transferId)) throw new ValidationError("Choose a different member to receive records");

  const membership = await Membership.findOne({ workspaceId: ctx.workspaceId, userId });
  if (!membership) throw new NotFoundError("Member");
  if (membership.role === "owner") throw new ForbiddenError("The workspace owner cannot be deactivated");
  const target = await Membership.findOne({ workspaceId: ctx.workspaceId, userId: transferId, status: "active" });
  if (!target) throw new ValidationError("Transfer target must be an active member");

  const scope = { workspaceId: ctx.workspaceId, ownerId: userId };
  const [leads, deals, contacts, companies, tasks] = await Promise.all([
    Lead.updateMany(scope, { ownerId: transferId }),
    Deal.updateMany(scope, { ownerId: transferId }),
    Contact.updateMany(scope, { ownerId: transferId }),
    Company.updateMany(scope, { ownerId: transferId }),
    Task.updateMany({ workspaceId: ctx.workspaceId, assignedTo: userId, status: "open" }, { assignedTo: transferId }),
  ]);
  membership.status = "deactivated";
  await membership.save();
  const transferred = {
    leads: leads.modifiedCount,
    deals: deals.modifiedCount,
    contacts: contacts.modifiedCount,
    companies: companies.modifiedCount,
    tasks: tasks.modifiedCount,
  };
  await audit(ctx, "member.deactivated", "member", userId, { after: { transferTo, ...transferred } });
  ok(res, { deactivated: true, transferred });
});

workspaceRouter.post("/members/:userId/reactivate", requireAuth, requireWorkspace, async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "members:manage");
  const userId = toObjectId(paramId(req.params.userId));
  const membership = await Membership.findOneAndUpdate(
    { workspaceId: ctx.workspaceId, userId },
    { status: "active" },
    { returnDocument: "after" },
  );
  if (!membership) throw new NotFoundError("Member");
  await audit(ctx, "member.reactivated", "member", userId);
  ok(res, { reactivated: true });
});

// ---------- Invitations ----------

const INVITE_DAYS = 7;

workspaceRouter.get("/invitations", requireAuth, requireWorkspace, async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "members:manage");
  const invites = await Invitation.find({ workspaceId: ctx.workspaceId, status: "pending" }).sort({ createdAt: -1 }).lean();
  ok(
    res,
    invites.map((i) => ({ ...i, expired: i.expiresAt < new Date() })),
  );
});

workspaceRouter.post("/invitations", requireAuth, requireWorkspace, async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "members:manage");
  const input = parse(
    z.object({ email: z.string().trim().toLowerCase().email("Enter a valid email"), role: z.enum(ROLES).exclude(["owner"]) }),
    req.body,
  );
  if (input.role === "admin" && ctx.role !== "owner") throw new ForbiddenError("Only the owner can invite admins");

  const existingUser = await User.findOne({ email: input.email }).select("_id").lean();
  if (existingUser && (await Membership.exists({ workspaceId: ctx.workspaceId, userId: existingUser._id }))) {
    throw new ConflictError("ALREADY_MEMBER", "This person is already a member", { email: "Already a member" });
  }
  await Invitation.updateMany({ workspaceId: ctx.workspaceId, email: input.email, status: "pending" }, { status: "revoked" });

  const token = randomToken();
  const invite = await Invitation.create({
    workspaceId: ctx.workspaceId,
    email: input.email,
    role: input.role,
    tokenHash: sha256(token),
    invitedBy: ctx.userId,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
  });
  const workspace = await Workspace.findById(ctx.workspaceId).select("name").lean();
  const inviteUrl = `${appUrl()}/invite/${token}`;
  let emailSent = false;
  if (emailEnabled()) {
    emailSent = await sendEmail(
      input.email,
      `You're invited to ${workspace?.name} on LeadFlow`,
      emailLayout(`Join ${workspace?.name}`, `You have been invited to join as ${input.role.replace("_", " ")}. This invitation expires in ${INVITE_DAYS} days.`, "Accept invitation", inviteUrl),
    );
  }
  await audit(ctx, "invitation.created", "invitation", invite._id, { entityName: input.email, after: { role: input.role } });
  created(res, { id: String(invite._id), email: input.email, role: input.role, inviteUrl, emailSent });
});

workspaceRouter.delete("/invitations/:id", requireAuth, requireWorkspace, async (req, res) => {
  const ctx = ctxOf(req);
  requirePermission(ctx, "members:manage");
  const invite = await Invitation.findOneAndUpdate(
    { _id: toObjectId(paramId(req.params.id)), workspaceId: ctx.workspaceId, status: "pending" },
    { status: "revoked" },
  );
  if (!invite) throw new NotFoundError("Invitation");
  await audit(ctx, "invitation.revoked", "invitation", invite._id, { entityName: invite.email });
  ok(res, { revoked: true });
});

workspaceRouter.get("/invitations/token/:token", async (req, res) => {
  const invite = await Invitation.findOne({ tokenHash: sha256(String(req.params.token)) }).lean();
  if (!invite) throw new NotFoundError("Invitation");
  const workspace = await Workspace.findById(invite.workspaceId).select("name").lean();
  ok(res, {
    email: invite.email,
    role: invite.role,
    workspaceName: workspace?.name,
    status: invite.status,
    expired: invite.expiresAt < new Date(),
  });
});

workspaceRouter.post("/invitations/accept", requireAuth, async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
  const invite = await Invitation.findOne({ tokenHash: sha256(token), status: "pending" });
  if (!invite || invite.expiresAt < new Date()) throw new AppError(410, "INVITE_INVALID", "This invitation is invalid or has expired");
  const user = await User.findById(req.userId).select("email name").lean();
  if (!user || user.email !== invite.email) {
    throw new ForbiddenError(`This invitation was sent to ${invite.email}. Sign in with that email to accept it.`);
  }
  await Membership.updateOne(
    { workspaceId: invite.workspaceId, userId: req.userId },
    { $set: { role: invite.role, status: "active" } },
    { upsert: true },
  );
  invite.status = "accepted";
  invite.acceptedAt = new Date();
  await invite.save();
  await User.updateOne({ _id: req.userId }, { activeWorkspaceId: invite.workspaceId });
  await audit({ workspaceId: invite.workspaceId, userId: req.userId! }, "invitation.accepted", "member", req.userId!, {
    entityName: user.email,
    after: { role: invite.role },
  });
  await notify({
    workspaceId: invite.workspaceId,
    userId: invite.invitedBy,
    type: "invitation_accepted",
    title: `${user.name} joined the workspace`,
    body: `Role: ${invite.role.replace("_", " ")}`,
    link: "/settings/team",
  });
  ok(res, await getSession(req.userId!));
});
