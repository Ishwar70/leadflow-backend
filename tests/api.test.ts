import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { disconnectDB } from "../src/db/connect";

let replSet: MongoMemoryReplSet;
let app: Express;

type Agent = ReturnType<typeof request.agent>;

async function signup(name: string, email: string, workspace?: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ name, email, password: "Password123" });
  expect(res.status).toBe(201);
  if (workspace) {
    const ws = await agent.post("/api/workspaces").send({ name: workspace, currency: "INR" });
    expect(ws.status).toBe(201);
  }
  return agent;
}

async function invite(owner: Agent, email: string, role: string, name: string): Promise<Agent> {
  const inv = await owner.post("/api/invitations").send({ email, role });
  expect(inv.status).toBe(201);
  const token = inv.body.data.inviteUrl.split("/invite/")[1];
  const member = await signup(name, email);
  const accepted = await member.post("/api/invitations/accept").send({ token });
  expect(accepted.status).toBe(200);
  return member;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replSet.getUri("leadflow-test");
  process.env.JWT_SECRET = "test-secret-test-secret-123";
  process.env.NODE_ENV = "test";
  process.env.CRON_SECRET = "cron-secret";
  app = createApp();
});

afterAll(async () => {
  await disconnectDB();
  await replSet?.stop();
});

describe("auth", () => {
  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/leads");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("validates registration input", async () => {
    const res = await request(app).post("/api/auth/register").send({ name: "A", email: "bad", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fieldErrors.email).toBeDefined();
  });

  it("requires a workspace before tenant routes", async () => {
    const agent = await signup("No Workspace", "nows@example.com");
    const res = await agent.get("/api/leads");
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("NO_WORKSPACE");
  });
});

describe("lead-to-revenue journey", () => {
  let owner: Agent;
  let leadId: string;
  let dealId: string;

  beforeAll(async () => {
    owner = await signup("Owner One", "owner1@example.com", "Acme Hotels");
  });

  it("creates a lead and warns about duplicates", async () => {
    const res = await owner.post("/api/leads").send({
      firstName: "Rahul",
      lastName: "Sharma",
      email: "Rahul@Example.com",
      phone: "98765 43210",
      companyName: "ABC Hotels",
      source: "website",
      estimatedValue: 250000,
    });
    expect(res.status).toBe(201);
    leadId = res.body.data._id;
    expect(res.body.data.normalizedPhone).toBe("+919876543210");

    const dup = await owner.post("/api/leads").send({ firstName: "R", email: "rahul@example.com" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("DUPLICATE_LEAD");

    const forced = await owner.post("/api/leads").send({ firstName: "R", email: "rahul@example.com", allowDuplicate: true });
    expect(forced.status).toBe(201);
  });

  it("lists and searches leads with pagination meta", async () => {
    const res = await owner.get("/api/leads?q=abc&limit=10");
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0].firstName).toBe("Rahul");
  });

  it("logs a call and moves lead to contacted", async () => {
    const res = await owner.post("/api/activities").send({ type: "call", entityType: "lead", entityId: leadId, body: "Intro call" });
    expect(res.status).toBe(201);
    const lead = await owner.get(`/api/leads/${leadId}`);
    expect(lead.body.data.status).toBe("contacted");
  });

  it("converts the lead into contact, company and deal in one transaction", async () => {
    const res = await owner.post(`/api/leads/${leadId}/convert`).send({ createCompany: true, createDeal: true });
    expect(res.status).toBe(200);
    expect(res.body.data.contactId).toBeTruthy();
    expect(res.body.data.companyId).toBeTruthy();
    dealId = res.body.data.dealId;

    const again = await owner.post(`/api/leads/${leadId}/convert`).send({});
    expect(again.status).toBe(409);

    const timeline = await owner.get(`/api/activities?entityType=company&entityId=${res.body.data.companyId}`);
    expect(timeline.body.data.some((a: { type: string }) => a.type === "call")).toBe(true);
  });

  it("moves the deal through stages and requires won/lost details", async () => {
    const deal = await owner.get(`/api/deals/${dealId}`);
    const stages = deal.body.data.pipeline.stages;
    const proposal = stages.find((s: { name: string }) => s.name === "Proposal");
    const moved = await owner.patch(`/api/deals/${dealId}/stage`).send({ stageId: proposal._id });
    expect(moved.status).toBe(200);
    expect(moved.body.data.probability).toBe(50);

    const wonNoAmount = await owner.post(`/api/deals/${dealId}/won`).send({});
    expect(wonNoAmount.status).toBe(400);

    const lostNoReason = await owner.post(`/api/deals/${dealId}/lost`).send({});
    expect(lostNoReason.status).toBe(400);

    const won = await owner.post(`/api/deals/${dealId}/won`).send({ finalAmount: 240000, closedAt: new Date().toISOString() });
    expect(won.status).toBe(200);
    expect(won.body.data.status).toBe("won");

    const history = await owner.get(`/api/deals/${dealId}`);
    expect(history.body.data.history.length).toBe(3);
  });

  it("reflects stored data in the dashboard", async () => {
    const res = await owner.get("/api/reports/overview");
    expect(res.status).toBe(200);
    expect(res.body.data.kpis.wonRevenue).toBe(240000);
    expect(res.body.data.kpis.winRate).toBe(100);
    expect(res.body.data.kpis.newLeads).toBe(2);
  });

  it("completes a task and records an activity", async () => {
    const task = await owner.post("/api/tasks").send({
      title: "Send proposal",
      type: "email",
      dueAt: new Date(Date.now() - 3600_000).toISOString(),
      relatedType: "deal",
      relatedId: dealId,
    });
    expect(task.status).toBe(201);
    const overdue = await owner.get("/api/tasks?view=overdue");
    expect(overdue.body.meta.total).toBe(1);
    const done = await owner.patch(`/api/tasks/${task.body.data._id}/complete`);
    expect(done.body.data.status).toBe("completed");
    const timeline = await owner.get(`/api/activities?entityType=deal&entityId=${dealId}`);
    expect(timeline.body.data.some((a: { type: string }) => a.type === "task_completed")).toBe(true);
  });

  it("imports CSV with row-level errors and duplicate skipping", async () => {
    const csv = "Name,Email,Phone,Source\nAsha Rao,asha@example.com,9988776655,referral\n,missing@example.com,,website\nDup,rahul@example.com,,website\nBad,not-an-email,,website";
    const preview = await owner.post("/api/leads/import/preview").send({ csv });
    expect(preview.body.data.suggestedMapping).toEqual({ Name: "firstName", Email: "email", Phone: "phone", Source: "source" });
    const res = await owner.post("/api/leads/import").send({ csv, mapping: preview.body.data.suggestedMapping });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.skipped).toHaveLength(1);
    expect(res.body.data.errors).toHaveLength(2);
  });

  it("writes an audit trail visible to the owner", async () => {
    const res = await owner.get("/api/audit-logs");
    expect(res.status).toBe(200);
    const actions = res.body.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["lead.created", "lead.converted", "deal.won", "lead.imported"]));
  });
});

describe("tenant isolation", () => {
  let ownerA: Agent;
  let ownerB: Agent;
  let leadA: string;

  beforeAll(async () => {
    ownerA = await signup("Tenant A", "a@example.com", "Workspace A");
    ownerB = await signup("Tenant B", "b@example.com", "Workspace B");
    const lead = await ownerA.post("/api/leads").send({ firstName: "Secret", lastName: "Lead", email: "secret@a.com" });
    leadA = lead.body.data._id;
  });

  it("Workspace B cannot read, update, archive or convert Workspace A records", async () => {
    expect((await ownerB.get(`/api/leads/${leadA}`)).status).toBe(404);
    expect((await ownerB.patch(`/api/leads/${leadA}`).send({ firstName: "Hacked" })).status).toBe(404);
    expect((await ownerB.post(`/api/leads/${leadA}/archive`)).status).toBe(404);
    expect((await ownerB.post(`/api/leads/${leadA}/convert`).send({})).status).toBe(404);
    expect((await ownerB.get(`/api/activities?entityType=lead&entityId=${leadA}`)).status).toBe(404);
    expect(
      (await ownerB.post("/api/tasks").send({ title: "x", dueAt: new Date().toISOString(), relatedType: "lead", relatedId: leadA })).status,
    ).toBe(404);
  });

  it("search, lists, exports and reports are tenant-scoped", async () => {
    const search = await ownerB.get("/api/search?q=secret");
    expect(search.body.data.leads).toHaveLength(0);
    const list = await ownerB.get("/api/leads");
    expect(list.body.meta.total).toBe(0);
    const exported = await ownerB.get("/api/leads/export");
    expect(exported.text).not.toContain("secret@a.com");
    const report = await ownerB.get("/api/reports/overview");
    expect(report.body.data.kpis.totalLeads).toBe(0);
    const bulk = await ownerB.post("/api/leads/bulk").send({ action: "archive", ids: [leadA] });
    expect(bulk.body.data.updated).toBe(0);
  });

  it("cannot switch into a workspace without membership", async () => {
    const me = await ownerA.get("/api/auth/me");
    const wsA = me.body.data.activeWorkspace.id;
    expect((await ownerB.post(`/api/workspaces/${wsA}/switch`)).status).toBe(404);
  });
});

describe("role-based access control", () => {
  let owner: Agent;
  let rep: Agent;
  let viewer: Agent;
  let repId: string;
  let ownerLead: string;

  beforeAll(async () => {
    owner = await signup("RBAC Owner", "rbac-owner@example.com", "RBAC Co");
    rep = await invite(owner, "rep@example.com", "sales_rep", "Sales Rep");
    viewer = await invite(owner, "viewer@example.com", "viewer", "Viewer");
    repId = (await rep.get("/api/auth/me")).body.data.user.id;
    ownerLead = (await owner.post("/api/leads").send({ firstName: "Owner", lastName: "Lead" })).body.data._id;
    await owner.post("/api/leads").send({ firstName: "Rep", lastName: "Lead", ownerId: repId });
  });

  it("sales rep only sees assigned leads", async () => {
    const list = await rep.get("/api/leads");
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].firstName).toBe("Rep");
    expect((await rep.get(`/api/leads/${ownerLead}`)).status).toBe(404);
  });

  it("sales rep cannot access admin settings or reassign", async () => {
    expect((await rep.get("/api/audit-logs")).status).toBe(403);
    expect((await rep.post("/api/invitations").send({ email: "x@example.com", role: "viewer" })).status).toBe(403);
    expect((await rep.post("/api/pipelines").send({ name: "Mine" })).status).toBe(403);
    const ownerId = (await owner.get("/api/auth/me")).body.data.user.id;
    expect((await rep.post("/api/leads").send({ firstName: "X", ownerId })).status).toBe(403);
  });

  it("viewer can read but not write", async () => {
    expect((await viewer.get("/api/leads")).body.meta.total).toBe(2);
    expect((await viewer.post("/api/leads").send({ firstName: "Nope" })).status).toBe(403);
    expect((await viewer.patch(`/api/leads/${ownerLead}`).send({ firstName: "Nope" })).status).toBe(403);
  });

  it("only the owner can grant the admin role", async () => {
    const admin = await invite(owner, "rbac-admin@example.com", "admin", "Admin");
    const viewerId = (await viewer.get("/api/auth/me")).body.data.user.id;
    expect((await admin.patch(`/api/members/${viewerId}`).send({ role: "admin" })).status).toBe(403);
    expect((await admin.patch(`/api/members/${viewerId}`).send({ role: "manager" })).status).toBe(200);
    expect((await owner.patch(`/api/members/${viewerId}`).send({ role: "viewer" })).status).toBe(200);
  });

  it("owner can deactivate a member and transfer records", async () => {
    const ownerId = (await owner.get("/api/auth/me")).body.data.user.id;
    const res = await owner.post(`/api/members/${repId}/deactivate`).send({ transferTo: ownerId });
    expect(res.status).toBe(200);
    expect(res.body.data.transferred.leads).toBe(1);
    expect((await rep.get("/api/leads")).status).toBe(403);
  });
});

describe("public lead capture", () => {
  it("creates leads with an API key, assigns and creates a follow-up task, and is idempotent", async () => {
    const owner = await signup("API Owner", "api-owner@example.com", "API Co");
    const key = await owner.post("/api/api-keys").send({ name: "Website" });
    expect(key.status).toBe(201);
    const secret = key.body.data.key;

    expect((await request(app).post("/api/public/leads").send({ firstName: "x" })).status).toBe(401);

    const res = await request(app)
      .post("/api/public/leads")
      .set("x-api-key", secret)
      .set("Idempotency-Key", "form-123")
      .send({ firstName: "Web", lastName: "Visitor", email: "web@visitor.com", message: "Need a demo" });
    expect(res.status).toBe(201);
    const again = await request(app)
      .post("/api/public/leads")
      .set("x-api-key", secret)
      .set("Idempotency-Key", "form-123")
      .send({ firstName: "Web", lastName: "Visitor", email: "web@visitor.com" });
    expect(again.body.data.duplicate).toBe(true);

    const tasks = await owner.get("/api/tasks?view=open");
    expect(tasks.body.data[0].title).toContain("Web Visitor");
    expect((await owner.get("/api/leads")).body.meta.total).toBe(1);
  });

  it("cron endpoint requires the secret and sends reminders", async () => {
    expect((await request(app).get("/api/cron/reminders")).status).toBe(401);
    const res = await request(app).get("/api/cron/reminders").set("Authorization", "Bearer cron-secret");
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBeGreaterThan(0);
  });
});
