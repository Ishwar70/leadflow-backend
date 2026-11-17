import { Types } from "mongoose";
import { DEFAULT_STAGES, Pipeline } from "../../models/Deal";
import { User } from "../../models/User";
import { Membership, Workspace } from "../../models/Workspace";
import { permissionsFor, type Role } from "../../lib/permissions";
import { audit } from "../../lib/audit";

export async function createWorkspace(
  userId: Types.ObjectId,
  input: { name: string; industry?: string; size?: string; timezone?: string; country?: string; currency?: string; isDemo?: boolean },
) {
  const workspace = await Workspace.create({ ...input, ownerId: userId });
  await Membership.create({ workspaceId: workspace._id, userId, role: "owner" });
  await Pipeline.create({
    workspaceId: workspace._id,
    name: "Sales Pipeline",
    isDefault: true,
    stages: DEFAULT_STAGES.map((s) => ({ ...s })),
  });
  await User.updateOne({ _id: userId }, { activeWorkspaceId: workspace._id });
  await audit({ workspaceId: workspace._id, userId }, "workspace.created", "workspace", workspace._id, {
    entityName: workspace.name,
  });
  return workspace;
}

export async function getSession(userId: Types.ObjectId) {
  const user = await User.findById(userId).select("name email activeWorkspaceId createdAt").lean();
  if (!user) return null;
  const memberships = await Membership.find({ userId, status: "active" }).lean();
  const workspaces = await Workspace.find({ _id: { $in: memberships.map((m) => m.workspaceId) } })
    .select("name industry currency timezone isDemo")
    .lean();
  const items = workspaces.map((w) => ({
    id: String(w._id),
    name: w.name,
    industry: w.industry,
    currency: w.currency,
    isDemo: w.isDemo,
    role: memberships.find((m) => String(m.workspaceId) === String(w._id))!.role as Role,
  }));
  const active =
    items.find((w) => w.id === String(user.activeWorkspaceId)) ?? items[0] ?? null;
  return {
    user: { id: String(user._id), name: user.name, email: user.email },
    workspaces: items,
    activeWorkspace: active
      ? { ...active, timezone: workspaces.find((w) => String(w._id) === active.id)?.timezone }
      : null,
    permissions: active ? permissionsFor(active.role) : [],
  };
}
