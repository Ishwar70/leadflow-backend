import { Router } from "express";
import { env } from "../../config/env";
import { UnauthorizedError } from "../../lib/errors";
import { ok } from "../../lib/http";
import { Notification } from "../../models/System";
import { Task } from "../../models/Task";
import { Membership } from "../../models/Workspace";

export const cronRouter = Router();

/**
 * Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`. Each task is
 * re-checked against an active membership in its own workspace before notifying.
 */
cronRouter.get("/reminders", async (req, res) => {
  const secret = env().CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new UnauthorizedError("Invalid cron secret");

  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tasks = await Task.find({ status: "open", reminderSentAt: null, dueAt: { $lte: horizon } })
    .sort({ dueAt: 1 })
    .limit(1000)
    .lean();

  let sent = 0;
  for (const task of tasks) {
    const member = await Membership.exists({ workspaceId: task.workspaceId, userId: task.assignedTo, status: "active" });
    if (member) {
      const overdue = task.dueAt < now;
      await Notification.create({
        workspaceId: task.workspaceId,
        userId: task.assignedTo,
        type: overdue ? "task_overdue" : "task_due",
        title: overdue ? `Overdue: ${task.title}` : `Due soon: ${task.title}`,
        body: task.relatedName ? `Related to ${task.relatedName}` : "",
        link: "/tasks",
      });
      sent++;
    }
    await Task.updateOne({ _id: task._id, workspaceId: task.workspaceId }, { reminderSentAt: now });
  }
  ok(res, { scanned: tasks.length, sent });
});
