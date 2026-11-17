import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Router } from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { env } from "./config/env";
import { connectDB } from "./db/connect";
import { requireAuth, requireWorkspace } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { activityRouter } from "./modules/activities/activity.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { companyRouter } from "./modules/companies/company.routes";
import { contactRouter } from "./modules/contacts/contact.routes";
import { dealRouter } from "./modules/deals/deal.routes";
import { pipelineRouter } from "./modules/deals/pipeline.routes";
import { leadRouter } from "./modules/leads/lead.routes";
import { publicRouter } from "./modules/public/public.routes";
import { reportRouter, searchRouter } from "./modules/reports/report.routes";
import { cronRouter } from "./modules/system/cron.routes";
import { apiKeyRouter, auditRouter, notificationRouter } from "./modules/system/system.routes";
import { taskRouter } from "./modules/tasks/task.routes";
import { workspaceRouter } from "./modules/workspaces/workspace.routes";

export function createApp() {
  const app = express();
  const config = env();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());

  const allowedOrigins = config.FRONTEND_URL.split(",").map((o) => o.trim());
  app.use("/api/public", cors({ origin: "*", allowedHeaders: ["Content-Type", "x-api-key", "Idempotency-Key"] }));
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "4mb" }));
  app.use(cookieParser());

  app.get("/", (_req, res) => {
    res.json({ name: "LeadFlow CRM API", status: "ok", docs: "/api/health" });
  });

  app.get("/api/health", async (_req, res) => {
    let db = "disconnected";
    try {
      await connectDB();
      db = mongoose.connection.readyState === 1 ? "connected" : "connecting";
    } catch {
      db = "error";
    }
    res.status(db === "connected" ? 200 : 503).json({ success: db === "connected", data: { status: "ok", db, time: new Date().toISOString() } });
  });

  app.use("/api", async (_req, _res, next) => {
    await connectDB();
    next();
  });

  app.use("/api/auth", authRouter);
  app.use("/api/public", publicRouter);
  app.use("/api/cron", cronRouter);
  app.use("/api", workspaceRouter);

  const scoped = Router();
  scoped.use(requireAuth, requireWorkspace);
  scoped.use("/leads", leadRouter);
  scoped.use("/contacts", contactRouter);
  scoped.use("/companies", companyRouter);
  scoped.use("/pipelines", pipelineRouter);
  scoped.use("/deals", dealRouter);
  scoped.use("/tasks", taskRouter);
  scoped.use("/activities", activityRouter);
  scoped.use("/reports", reportRouter);
  scoped.use("/search", searchRouter);
  scoped.use("/audit-logs", auditRouter);
  scoped.use("/notifications", notificationRouter);
  scoped.use("/api-keys", apiKeyRouter);
  app.use("/api", scoped);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
