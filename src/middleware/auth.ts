import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { ForbiddenError, UnauthorizedError } from "../lib/errors";
import type { Role, WorkspaceContext } from "../lib/permissions";
import { AUTH_COOKIE, verifySession } from "../lib/tokens";
import { User } from "../models/User";
import { Membership } from "../models/Workspace";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: Types.ObjectId;
      ctx?: WorkspaceContext;
    }
  }
}

function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return (req.cookies?.[AUTH_COOKIE] as string | undefined) ?? null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  const userId = token ? verifySession(token) : null;
  if (!userId || !Types.ObjectId.isValid(userId)) throw new UnauthorizedError();
  req.userId = new Types.ObjectId(userId);
  next();
}

/**
 * Resolves the active workspace from the user's own stored preference and a
 * verified active membership. The client never supplies a workspaceId.
 */
export async function requireWorkspace(req: Request, _res: Response, next: NextFunction) {
  if (!req.userId) throw new UnauthorizedError();
  const user = await User.findById(req.userId).select("activeWorkspaceId").lean();
  if (!user) throw new UnauthorizedError();

  let membership = user.activeWorkspaceId
    ? await Membership.findOne({ userId: req.userId, workspaceId: user.activeWorkspaceId, status: "active" }).lean()
    : null;

  if (!membership) {
    membership = await Membership.findOne({ userId: req.userId, status: "active" }).sort({ createdAt: 1 }).lean();
    if (membership) await User.updateOne({ _id: req.userId }, { activeWorkspaceId: membership.workspaceId });
  }

  if (!membership) throw new ForbiddenError("NO_WORKSPACE");

  req.ctx = {
    userId: req.userId,
    workspaceId: membership.workspaceId as Types.ObjectId,
    role: membership.role as Role,
  };
  next();
}

export function ctxOf(req: Request): WorkspaceContext {
  if (!req.ctx) throw new UnauthorizedError();
  return req.ctx;
}
