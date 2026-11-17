import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { buildSearchText, normalizeEmail, normalizePhone } from "../lib/normalize";
import { Activity } from "../models/Activity";
import { Company, Contact } from "../models/Contact";
import { Deal, DealStageHistory, DEFAULT_STAGES, Pipeline } from "../models/Deal";
import { Lead } from "../models/Lead";
import { ApiKey, AuditLog, Notification } from "../models/System";
import { Task } from "../models/Task";
import { User } from "../models/User";
import { Invitation, Membership, Workspace } from "../models/Workspace";

export const DEMO_PASSWORD = "Demo@12345";

// Deterministic PRNG so every seed produces the same demo story.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const rand = rng(42);
const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000 - int(0, 8) * 60 * 60 * 1000);
const daysAhead = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000 + int(1, 8) * 60 * 60 * 1000);

const FIRST = ["Rahul", "Ananya", "Arjun", "Diya", "Kabir", "Isha", "Vivaan", "Meera", "Aditya", "Saanvi", "Reyansh", "Tara", "Nikhil", "Pooja", "Karan", "Riya", "Siddharth", "Neha", "Varun", "Kavya", "Ishaan", "Aisha", "Rohit", "Simran", "Aryan", "Zoya", "Manav", "Nisha", "Dev", "Priyanka", "Yash", "Sana", "Harsh", "Lavanya", "Omkar", "Fatima", "Tanvi", "Gaurav", "Ritika", "Samar"];
const LAST = ["Sharma", "Verma", "Patel", "Reddy", "Iyer", "Nair", "Gupta", "Khan", "Singh", "Joshi", "Menon", "Rao", "Bose", "Chopra", "Desai", "Kulkarni", "Pillai", "Saxena", "Bhat", "Mishra", "Agarwal", "Thomas", "Fernandes", "Malhotra"];
const INDUSTRIES = ["Hotels", "Real estate", "Clinics", "Gyms", "Restaurants", "Software services", "Manufacturing"] as const;
const COMPANY_WORDS: Record<(typeof INDUSTRIES)[number], string[]> = {
  Hotels: ["Grand Residency", "Lakeview Suites", "Palm Court Hotels", "Heritage Inn", "Skyline Stays", "Coastal Retreat"],
  "Real estate": ["Urban Nest Realty", "Keystone Builders", "Greenfield Estates", "Prime Spaces", "Brickline Homes", "Horizon Properties"],
  Clinics: ["CarePoint Clinics", "Wellspring Health", "Smile Dental Studio", "Pulse Diagnostics", "Lotus Skin Clinic", "Apex Physio"],
  Gyms: ["IronCore Fitness", "FitNation Studios", "Peak Performance Gym", "Zen Yoga Loft", "Stride Athletics", "PowerHouse Gyms"],
  Restaurants: ["Spice Route Kitchen", "The Curry Collective", "Urban Tandoor", "Saffron Table", "Bombay Bistro", "Green Bowl Cafe"],
  "Software services": ["Byteforge Labs", "CloudNimbus Tech", "Pixelcraft Digital", "Datastream Analytics", "Codewave Systems", "Nexgen Softworks"],
  Manufacturing: ["Precision Castings", "Shakti Polymers", "Vortex Engineering", "Allied Textiles", "Titan Fasteners", "Everest Packaging"],
};
const CITIES = ["Mumbai", "Bengaluru", "Delhi", "Pune", "Hyderabad", "Chennai", "Ahmedabad", "Jaipur", "Kochi", "Indore"];
const TITLES = ["Founder", "CEO", "Operations Head", "Marketing Manager", "General Manager", "Procurement Lead", "Director", "Owner", "IT Manager", "Head of Sales"];
const SOURCES = ["website", "website", "website", "referral", "referral", "ads", "ads", "email", "phone", "whatsapp", "event", "other"] as const;
const LOST_REASONS = ["Budget constraints", "Chose a competitor", "No decision made", "Timing not right", "Requirements changed"];
const NOTES = [
  "Discussed current process - they track enquiries in spreadsheets and miss follow-ups during peak season.",
  "Interested in pipeline reporting for weekly management reviews.",
  "Asked for pricing for a 10-seat team and onboarding support.",
  "Decision maker is the founder; operations head will evaluate first.",
  "Wants WhatsApp enquiries captured centrally. Shared roadmap honestly.",
  "Requested a demo for the regional sales team next week.",
  "Concerned about data migration from their old tool. Offered CSV import walkthrough.",
  "Budget approved for this quarter, awaiting procurement sign-off.",
];

interface DemoUser {
  key: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "manager" | "sales_rep" | "viewer";
}

const DEMO_USERS: DemoUser[] = [
  { key: "owner", name: "Aarav Mehta", email: "owner@demo.leadflow.app", role: "owner" },
  { key: "admin", name: "Priya Nair", email: "admin@demo.leadflow.app", role: "admin" },
  { key: "manager", name: "Rohan Kapoor", email: "manager@demo.leadflow.app", role: "manager" },
  { key: "salesrep", name: "Sneha Iyer", email: "salesrep@demo.leadflow.app", role: "sales_rep" },
  { key: "rep2", name: "Vikram Rao", email: "rep2@demo.leadflow.app", role: "sales_rep" },
  { key: "viewer", name: "Kabir Malhotra", email: "viewer@demo.leadflow.app", role: "viewer" },
];

async function wipeDemo() {
  const demoUsers = await User.find({ email: /@demo\.leadflow\.app$/ }).select("_id").lean();
  const workspaces = await Workspace.find({ isDemo: true }).select("_id").lean();
  const wsIds = workspaces.map((w) => w._id);
  const filter = { workspaceId: { $in: wsIds } };
  await Promise.all([
    Lead.deleteMany(filter),
    Contact.deleteMany(filter),
    Company.deleteMany(filter),
    Deal.deleteMany(filter),
    DealStageHistory.deleteMany(filter),
    Pipeline.deleteMany(filter),
    Task.deleteMany(filter),
    Activity.deleteMany(filter),
    AuditLog.deleteMany(filter),
    Notification.deleteMany(filter),
    ApiKey.deleteMany(filter),
    Invitation.deleteMany(filter),
    Membership.deleteMany({ $or: [filter, { userId: { $in: demoUsers.map((u) => u._id) } }] }),
  ]);
  await Workspace.deleteMany({ _id: { $in: wsIds } });
  await User.deleteMany({ _id: { $in: demoUsers.map((u) => u._id) } });
}

export async function seedDemo(log: (msg: string) => void = console.log) {
  await wipeDemo();
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const users = await User.insertMany(DEMO_USERS.map((u) => ({ name: u.name, email: u.email, passwordHash })));
  const byKey = Object.fromEntries(DEMO_USERS.map((u, i) => [u.key, users[i]]));
  const owner = byKey.owner;
  const sellers = [byKey.manager, byKey.salesrep, byKey.rep2];

  const ws = await Workspace.create({
    name: "Northwind Growth Partners",
    industry: "Software services",
    size: "11-50",
    timezone: "Asia/Kolkata",
    country: "India",
    currency: "INR",
    ownerId: owner._id,
    isDemo: true,
  });
  await Membership.insertMany(DEMO_USERS.map((u, i) => ({ workspaceId: ws._id, userId: users[i]._id, role: u.role })));
  await User.updateMany({ _id: { $in: users.map((u) => u._id) } }, { activeWorkspaceId: ws._id });

  const stages = DEFAULT_STAGES.map((s) => ({ ...s, _id: new Types.ObjectId() }));
  const pipeline = await Pipeline.create({ workspaceId: ws._id, name: "Sales Pipeline", isDefault: true, stages });
  const openStages = stages.filter((s) => s.type === "open");
  const wonStage = stages.find((s) => s.type === "won")!;
  const lostStage = stages.find((s) => s.type === "lost")!;
  await Pipeline.create({
    workspaceId: ws._id,
    name: "Enterprise Renewals",
    stages: [
      { name: "Renewal due", order: 0, probability: 40, type: "open", color: "#6366f1" },
      { name: "Commercials", order: 1, probability: 70, type: "open", color: "#f59e0b" },
      { name: "Renewed", order: 2, probability: 100, type: "won", color: "#10b981" },
      { name: "Churned", order: 3, probability: 0, type: "lost", color: "#f43f5e" },
    ],
  });

  // Companies
  const companyDocs = Array.from({ length: 40 }, (_, i) => {
    const industry = INDUSTRIES[i % INDUSTRIES.length];
    const base = COMPANY_WORDS[industry][Math.floor(i / INDUSTRIES.length) % 6];
    const name = i >= 42 ? `${base} ${i}` : base;
    const city = pick(CITIES);
    const domain = `${name.toLowerCase().replace(/[^a-z]/g, "")}.example.com`;
    return {
      workspaceId: ws._id,
      name,
      domain,
      industry,
      size: pick(["1-10", "11-50", "51-200", "201-500"]),
      phone: `+91 ${int(70000, 99999)} ${int(10000, 99999)}`,
      city,
      country: "India",
      ownerId: pick(sellers)._id,
      createdBy: owner._id,
      searchText: buildSearchText(name, domain, city),
      createdAt: daysAgo(int(60, 200)),
    };
  });
  const companies = await Company.insertMany(companyDocs);

  // Contacts
  const contactDocs = Array.from({ length: 95 }, (_, i) => {
    const company = companies[i % companies.length];
    const firstName = pick(FIRST);
    const lastName = pick(LAST);
    const email = `${firstName}.${lastName}${i}@${company.domain}`.toLowerCase();
    const phone = `+91${int(7000000000, 9999999999)}`;
    return {
      workspaceId: ws._id,
      firstName,
      lastName,
      email,
      normalizedEmail: normalizeEmail(email),
      phone,
      normalizedPhone: normalizePhone(phone),
      jobTitle: pick(TITLES),
      companyId: company._id,
      ownerId: company.ownerId,
      city: company.city,
      country: "India",
      createdBy: owner._id,
      searchText: buildSearchText(firstName, lastName, email, phone, company.name),
      createdAt: daysAgo(int(30, 180)),
    };
  });
  const contacts = await Contact.insertMany(contactDocs);

  // Leads
  const statusPool = ["new", "new", "new", "contacted", "contacted", "contacted", "qualified", "qualified", "unqualified", "converted"] as const;
  const leadDocs = Array.from({ length: 250 }, (_, i) => {
    const firstName = pick(FIRST);
    const lastName = pick(LAST);
    const industry = pick(INDUSTRIES);
    const companyName = `${pick(COMPANY_WORDS[industry])}${rand() > 0.5 ? "" : ` ${pick(CITIES)}`}`;
    const email = `${firstName}.${lastName}.${i}@mail.example.com`.toLowerCase();
    const phone = `+91${int(7000000000, 9999999999)}`;
    const createdAt = daysAgo(Math.floor(Math.pow(rand(), 1.6) * 180));
    const status = pick(statusPool);
    const ownerId = pick(sellers)._id;
    return {
      workspaceId: ws._id,
      firstName,
      lastName,
      email,
      normalizedEmail: normalizeEmail(email),
      phone,
      normalizedPhone: normalizePhone(phone),
      companyName,
      jobTitle: pick(TITLES),
      source: pick(SOURCES),
      status,
      ownerId,
      estimatedValue: int(2, 60) * 10000,
      currency: "INR",
      tags: rand() > 0.6 ? [pick(["hot", "enterprise", "smb", "renewal", "partner"])] : [],
      city: pick(CITIES),
      country: "India",
      lastContactedAt: status === "new" ? null : new Date(createdAt.getTime() + int(1, 5) * 86400000),
      nextFollowUpAt: ["new", "contacted", "qualified"].includes(status) ? daysAhead(int(-5, 14)) : null,
      convertedAt: status === "converted" ? new Date(createdAt.getTime() + int(3, 20) * 86400000) : null,
      createdBy: ownerId,
      searchText: buildSearchText(firstName, lastName, email, phone, companyName),
      createdAt,
      updatedAt: createdAt,
    };
  });
  const leads = await Lead.insertMany(leadDocs);

  // Deals: 72 total - open across stages, plus won and lost history
  const dealDocs = Array.from({ length: 72 }, (_, i) => {
    const company = companies[i % companies.length];
    const contact = contacts.find((c) => String(c.companyId) === String(company._id)) ?? contacts[i];
    const createdAt = daysAgo(int(5, 170));
    let status: "open" | "won" | "lost" = "open";
    if (i < 22) status = "won";
    else if (i < 32) status = "lost";
    const stage = status === "won" ? wonStage : status === "lost" ? lostStage : openStages[i % openStages.length];
    const value = int(5, 90) * 10000;
    const closedAt = status === "open" ? null : new Date(Math.min(Date.now(), createdAt.getTime() + int(10, 60) * 86400000));
    const title = `${company.name} - ${pick(["CRM rollout", "Annual plan", "Team expansion", "Pilot", "Onboarding package", "Multi-branch setup"])}`;
    return {
      workspaceId: ws._id,
      title,
      pipelineId: pipeline._id,
      stageId: stage._id,
      ownerId: company.ownerId,
      companyId: company._id,
      contactId: contact._id,
      value,
      currency: "INR",
      probability: stage.probability,
      expectedCloseDate: status === "open" ? daysAhead(int(5, 75)) : closedAt,
      status,
      finalAmount: status === "won" ? Math.round(value * (0.85 + rand() * 0.2)) : null,
      closedAt,
      lostReason: status === "lost" ? pick(LOST_REASONS) : null,
      stageChangedAt: status === "open" ? daysAgo(int(1, 30)) : closedAt,
      createdBy: company.ownerId,
      searchText: buildSearchText(title, company.name),
      createdAt,
      updatedAt: closedAt ?? createdAt,
    };
  });
  const deals = await Deal.insertMany(dealDocs);
  await DealStageHistory.insertMany(
    deals.map((d) => ({
      workspaceId: ws._id,
      dealId: d._id,
      toStageId: d.stageId,
      toStageName: stages.find((s) => String(s._id) === String(d.stageId))!.name,
      changedBy: d.ownerId,
    })),
  );

  // Tasks
  const taskTypes = ["call", "email", "meeting", "follow_up", "general"] as const;
  const taskDocs = Array.from({ length: 160 }, (_, i) => {
    const useDeal = i % 3 === 0;
    const lead = leads[i % leads.length];
    const deal = deals[i % deals.length];
    const type = pick(taskTypes);
    const completed = i % 4 === 0;
    const dueAt = completed ? daysAgo(int(1, 40)) : i % 5 === 0 ? daysAgo(int(1, 6)) : daysAhead(int(0, 20));
    const relatedName = useDeal ? deal.title : `${lead.firstName} ${lead.lastName}`;
    return {
      workspaceId: ws._id,
      title: `${{ call: "Call", email: "Email", meeting: "Meeting with", follow_up: "Follow up with", general: "Prepare notes for" }[type]} ${relatedName}`,
      type,
      priority: pick(["low", "medium", "medium", "high"]),
      dueAt,
      status: completed ? "completed" : "open",
      completedAt: completed ? dueAt : null,
      assignedTo: useDeal ? deal.ownerId : lead.ownerId,
      relatedType: useDeal ? "deal" : "lead",
      relatedId: useDeal ? deal._id : lead._id,
      relatedName,
      createdBy: owner._id,
    };
  });
  await Task.insertMany(taskDocs);

  // Activities
  const manualTypes = ["note", "call", "call", "meeting", "email", "whatsapp"] as const;
  const activityDocs = Array.from({ length: 350 }, (_, i) => {
    const onDeal = i % 3 === 0;
    const type = pick(manualTypes);
    const actor = pick(sellers);
    if (onDeal) {
      const deal = deals[i % deals.length];
      return {
        workspaceId: ws._id,
        type,
        links: [
          { entityType: "deal", entityId: deal._id },
          { entityType: "company", entityId: deal.companyId },
          { entityType: "contact", entityId: deal.contactId },
        ],
        actorId: actor._id,
        summary: { note: "Note added", call: "Call logged", meeting: "Meeting logged", email: "Email logged", whatsapp: "WhatsApp conversation logged" }[type],
        body: pick(NOTES),
        isSystem: false,
        occurredAt: daysAgo(int(0, 120)),
      };
    }
    const lead = leads[i % leads.length];
    return {
      workspaceId: ws._id,
      type,
      links: [{ entityType: "lead", entityId: lead._id }],
      actorId: lead.ownerId,
      summary: { note: "Note added", call: "Call logged", meeting: "Meeting logged", email: "Email logged", whatsapp: "WhatsApp conversation logged" }[type],
      body: pick(NOTES),
      isSystem: false,
      occurredAt: daysAgo(int(0, 120)),
    };
  });
  await Activity.insertMany(activityDocs);

  await AuditLog.create({
    workspaceId: ws._id,
    actorId: owner._id,
    actorName: owner.name,
    action: "workspace.seeded",
    entityType: "workspace",
    entityId: ws._id,
    entityName: ws.name,
  });

  // Second workspace to demonstrate multi-workspace switching and tenant isolation
  const ws2 = await Workspace.create({
    name: "Bluefin Realty (Demo)",
    industry: "Real estate",
    size: "1-10",
    currency: "INR",
    ownerId: owner._id,
    isDemo: true,
  });
  await Membership.create({ workspaceId: ws2._id, userId: owner._id, role: "owner" });
  const stages2 = DEFAULT_STAGES.map((s) => ({ ...s, _id: new Types.ObjectId() }));
  await Pipeline.create({ workspaceId: ws2._id, name: "Property Sales", isDefault: true, stages: stages2 });
  await Lead.insertMany(
    Array.from({ length: 30 }, (_, i) => {
      const firstName = pick(FIRST);
      const lastName = pick(LAST);
      const email = `${firstName}.${lastName}.bf${i}@mail.example.com`.toLowerCase();
      return {
        workspaceId: ws2._id,
        firstName,
        lastName,
        email,
        normalizedEmail: email,
        companyName: "",
        jobTitle: "Home buyer",
        source: pick(SOURCES),
        status: pick(["new", "contacted", "qualified"]),
        ownerId: owner._id,
        estimatedValue: int(30, 200) * 100000,
        currency: "INR",
        city: pick(CITIES),
        createdBy: owner._id,
        searchText: buildSearchText(firstName, lastName, email),
      };
    }),
  );

  log(`Seeded "${ws.name}": 6 users, 40 companies, 95 contacts, 250 leads, 72 deals, 160 tasks, 350 activities`);
  log(`Seeded "${ws2.name}" for workspace switching (30 leads)`);
  log(`Demo password for all users: ${DEMO_PASSWORD}`);
  return { workspaceId: ws._id, secondWorkspaceId: ws2._id };
}
